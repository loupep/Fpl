package io.github.loupep.fplmanager;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * Shows FPL's own login page. Two ways to finish:
 *  - "oauth": the page is the standard sign-in (the same one the FPL website
 *    uses). When it sends the user back to the FPL site with a one-time code,
 *    we stop there and hand the address to the web app, which swaps the code
 *    for a login.
 *  - "site": the FPL website itself; once it has logged in, we read the login
 *    it keeps in its storage (the same thing the desktop console snippet does).
 */
public class LoginActivity extends Activity {
    static final String EXTRA_MODE = "mode";
    static final String EXTRA_URL = "url";
    static final String EXTRA_REDIRECT = "redirect";
    static final String EXTRA_RESULT = "result";

    private static final String FPL_HOST = "fantasy.premierleague.com";
    private static final String CAPTURE_JS =
            "(function(){try{var stores=[localStorage,sessionStorage];"
            + "for(var i=0;i<stores.length;i++){var s=stores[i];"
            + "for(var j=0;j<s.length;j++){var k=s.key(j);"
            + "if(k&&k.indexOf('oidc.user:')===0){var v=JSON.parse(s.getItem(k));"
            + "if(!v||!v.access_token)continue;var p=k.split(':');"
            + "return JSON.stringify({authority:p.slice(1,-1).join(':'),client_id:p[p.length-1],"
            + "access_token:v.access_token,refresh_token:v.refresh_token||null,expires_at:v.expires_at||null});}}}"
            + "}catch(e){}return null;})()";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;
    private String mode;
    private String redirect;
    private boolean done;

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            captureSiteLogin();
            if (!done) handler.postDelayed(this, 1000);
        }
    };

    /** Forgets the FPL login page's cookies and storage, so the next login starts fresh. */
    static void clearWebLoginData() {
        CookieManager cookies = CookieManager.getInstance();
        cookies.removeAllCookies(null);
        cookies.flush();
        WebStorage.getInstance().deleteAllData();
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent intent = getIntent();
        mode = intent.getStringExtra(EXTRA_MODE);
        String url = intent.getStringExtra(EXTRA_URL);
        redirect = intent.getStringExtra(EXTRA_REDIRECT);
        if (redirect == null) redirect = "";
        if (url == null || !url.startsWith("https://")) {
            cancel();
            return;
        }

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(MainActivity.BACKGROUND);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(16), dp(8), dp(8), dp(8));
        TextView title = new TextView(this);
        title.setText("Log in to FPL");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        bar.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        Button cancel = new Button(this);
        cancel.setText("Cancel");
        cancel.setOnClickListener(v -> cancel());
        bar.addView(cancel);
        root.addView(bar);

        TextView hint = new TextView(this);
        hint.setText("Sign in with your FPL email and password. You'll go back to FPL Manager by yourself once you're in.");
        hint.setTextColor(Color.parseColor("#94a3b2"));
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        hint.setPadding(dp(16), 0, dp(16), dp(8));
        root.addView(hint);

        ProgressBar progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(100);
        root.addView(progress, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(3)));

        webView = new WebView(this);
        root.addView(webView, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
        SystemBars.edgeToEdge(getWindow(), root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.INVISIBLE : View.VISIBLE);
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return finishIfSentBack(request.getUrl().toString());
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (finishIfSentBack(url)) view.stopLoading();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                captureSiteLogin();
            }
        });

        if ("site".equals(mode)) {
            // Drop any older website login so we only pick up a fresh one.
            WebStorage.getInstance().deleteAllData();
            handler.post(poll);
        }
        webView.loadUrl(url);
    }

    // "oauth": the login page is sending the user back to the FPL site with a code (or an error).
    private boolean finishIfSentBack(String url) {
        if (done || !"oauth".equals(mode) || redirect.isEmpty() || url == null || !url.startsWith(redirect)) return false;
        Uri u = Uri.parse(url);
        if (u.getQueryParameter("code") == null && u.getQueryParameter("error") == null) return false;
        try {
            finishWith(new JSONObject().put("url", url).toString());
        } catch (Exception e) {
            cancel();
        }
        return true;
    }

    // "site": wait until the FPL website has stored its login, then take it.
    private void captureSiteLogin() {
        if (done || !"site".equals(mode) || webView == null) return;
        String current = webView.getUrl();
        if (current == null || !FPL_HOST.equals(Uri.parse(current).getHost())) return;
        webView.evaluateJavascript(CAPTURE_JS, value -> {
            if (done || value == null || "null".equals(value)) return;
            try {
                Object decoded = new JSONTokener(value).nextValue();
                if (!(decoded instanceof String)) return;
                JSONObject login = new JSONObject((String) decoded);
                finishWith(new JSONObject().put("login", login).toString());
            } catch (Exception ignored) {
                // not logged in yet
            }
        });
    }

    private void finishWith(String resultJson) {
        if (done) return;
        done = true;
        handler.removeCallbacks(poll);
        setResult(RESULT_OK, new Intent().putExtra(EXTRA_RESULT, resultJson));
        finish();
    }

    private void cancel() {
        done = true;
        handler.removeCallbacks(poll);
        setResult(RESULT_CANCELED);
        finish();
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            cancel();
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(poll);
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
