package io.github.loupep.fplmanager;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

/** Hosts the FPL Manager web app and gives it what a browser can't: direct access to FPL and an in-app login. */
public class MainActivity extends Activity {
    private static final String START_URL = "https://" + NativeRoutes.APP_HOST + "/index.html";
    private static final int LOGIN_REQUEST = 1;
    static final int BACKGROUND = Color.parseColor("#0d1217");

    private WebView webView;
    private NativeRoutes routes;
    private volatile String pendingLoginResult;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        routes = new NativeRoutes(this);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BACKGROUND);
        webView = new WebView(this);
        webView.setBackgroundColor(BACKGROUND);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        SystemBars.edgeToEdge(getWindow(), root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        routes.setUserAgent(settings.getUserAgentString());

        webView.addJavascriptInterface(new Bridge(), "FplNative");
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return routes.handle(request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (NativeRoutes.APP_HOST.equals(url.getHost())) return false;
                openExternally(url);
                return true;
            }
        });
        webView.loadUrl(START_URL);
    }

    /** Methods the web app can call as window.FplNative.*. They run on a background thread. */
    private class Bridge {
        @JavascriptInterface
        public void startLogin(String requestJson) {
            runOnUiThread(() -> {
                try {
                    JSONObject request = new JSONObject(requestJson);
                    Intent intent = new Intent(MainActivity.this, LoginActivity.class);
                    intent.putExtra(LoginActivity.EXTRA_MODE, request.optString("mode", "oauth"));
                    intent.putExtra(LoginActivity.EXTRA_URL, request.getString("url"));
                    intent.putExtra(LoginActivity.EXTRA_REDIRECT, request.optString("redirect", ""));
                    startActivityForResult(intent, LOGIN_REQUEST);
                } catch (Exception e) {
                    deliverLoginResult("{\"error\":\"Couldn't open the FPL login page.\"}");
                }
            });
        }

        @JavascriptInterface
        public String takeLoginResult() {
            String result = pendingLoginResult;
            pendingLoginResult = null;
            return result;
        }

        @JavascriptInterface
        public void clearLoginData() {
            runOnUiThread(LoginActivity::clearWebLoginData);
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != LOGIN_REQUEST) return;
        String result = resultCode == RESULT_OK && data != null ? data.getStringExtra(LoginActivity.EXTRA_RESULT) : null;
        deliverLoginResult(result != null ? result : "{\"cancelled\":true}");
    }

    // The web app collects the result with takeLoginResult(). If Android
    // restarted the app meanwhile, the page picks it up when it starts.
    private void deliverLoginResult(String json) {
        pendingLoginResult = json;
        if (webView != null) {
            webView.evaluateJavascript("window.fplmNativeLoginDone && window.fplmNativeLoginDone()", null);
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript("(window.fplmBack && window.fplmBack()) ? 'handled' : 'no'", value -> {
            if (!"\"handled\"".equals(value)) super.onBackPressed();
        });
    }

    private void openExternally(Uri url) {
        String scheme = url.getScheme();
        if (!"https".equals(scheme) && !"http".equals(scheme) && !"mailto".equals(scheme)) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url));
        } catch (ActivityNotFoundException ignored) {
            // nothing can open it
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
