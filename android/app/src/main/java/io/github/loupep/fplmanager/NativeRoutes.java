package io.github.loupep.fplmanager;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Base64;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Answers the web app's requests inside the app, under https://appassets.androidplatform.net:
 *  - /__native/fpl/{host}/{path}  forwards the request to FPL (no browser CORS rules apply here)
 *  - /__native/session            reads or saves the login, kept in the app's private storage
 *  - anything else                serves the web app's files from the APK
 * Android doesn't pass request bodies to this handler, so the web app sends
 * them base64-encoded in an X-Fplm-Body header.
 */
final class NativeRoutes {
    static final String APP_HOST = "appassets.androidplatform.net";
    private static final String FPL_HOST = "fantasy.premierleague.com";
    private static final String LOGIN_HOST = "account.premierleague.com";
    private static final String BODY_HEADER = "x-fplm-body";
    private static final String SESSION_KEY = "session";

    private final Context context;
    private final SharedPreferences prefs;
    private volatile String userAgent = "";

    NativeRoutes(Context context) {
        this.context = context.getApplicationContext();
        this.prefs = this.context.getSharedPreferences("fpl_manager", Context.MODE_PRIVATE);
    }

    void setUserAgent(String userAgent) {
        this.userAgent = userAgent == null ? "" : userAgent;
    }

    WebResourceResponse handle(WebResourceRequest request) {
        Uri url = request.getUrl();
        if (!"https".equals(url.getScheme()) || !APP_HOST.equals(url.getHost())) return null;
        String path = url.getEncodedPath() == null ? "/" : url.getEncodedPath();
        try {
            if (path.equals("/__native/session")) return session(request);
            if (path.startsWith("/__native/fpl/")) {
                return forward(request, path.substring("/__native/fpl/".length()), url.getEncodedQuery());
            }
            return asset(url.getPath() == null ? "/" : url.getPath());
        } catch (IOException e) {
            return json(502, "{\"detail\":\"Couldn't reach FPL. Check your internet connection.\"}");
        } catch (RuntimeException e) {
            return json(500, "{\"detail\":\"Something went wrong in the app.\"}");
        }
    }

    // ------------------------------------------------------------ login storage

    // commit() rather than apply(): the login rotates on every renewal, so it
    // must be on disk before the web app carries on. This runs off the UI thread.
    @SuppressLint("ApplySharedPref")
    private WebResourceResponse session(WebResourceRequest request) {
        if ("GET".equals(request.getMethod())) {
            String stored = prefs.getString(SESSION_KEY, null);
            return stored == null ? empty(204) : text(200, "application/json", stored);
        }
        String body = header(request, BODY_HEADER);
        if (body == null) {
            prefs.edit().remove(SESSION_KEY).commit();
        } else {
            String session = new String(Base64.decode(body, Base64.DEFAULT), StandardCharsets.UTF_8);
            prefs.edit().putString(SESSION_KEY, session).commit();
        }
        return empty(204);
    }

    // ------------------------------------------------------------ FPL requests

    private static boolean allowedHost(String host) {
        return FPL_HOST.equals(host) || LOGIN_HOST.equals(host);
    }

    private WebResourceResponse forward(WebResourceRequest request, String rest, String query) throws IOException {
        int slash = rest.indexOf('/');
        String host = slash < 0 ? rest : rest.substring(0, slash);
        String path = slash < 0 ? "/" : rest.substring(slash);
        if (!allowedHost(host)) return json(403, "{\"detail\":\"The app only talks to FPL.\"}");

        URL target = new URL("https://" + host + path + (query == null || query.isEmpty() ? "" : "?" + query));
        HttpURLConnection conn = (HttpURLConnection) target.openConnection();
        conn.setInstanceFollowRedirects(false); // never send the login on to another address
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(30_000);
        String method = request.getMethod();
        conn.setRequestMethod(method);
        for (Map.Entry<String, String> h : request.getRequestHeaders().entrySet()) {
            String name = h.getKey().toLowerCase(Locale.ROOT);
            if (name.equals("accept") || name.equals("content-type") || name.equals("x-api-authorization")) {
                conn.setRequestProperty(h.getKey(), h.getValue());
            }
        }
        conn.setRequestProperty("User-Agent", userAgent);
        if (FPL_HOST.equals(host)) conn.setRequestProperty("Referer", "https://" + FPL_HOST + "/");

        String body = header(request, BODY_HEADER);
        if (body != null && !"GET".equals(method)) {
            if (FPL_HOST.equals(host)) conn.setRequestProperty("Origin", "https://" + FPL_HOST);
            byte[] bytes = Base64.decode(body, Base64.DEFAULT);
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(bytes);
            }
        }

        int status = conn.getResponseCode();
        if (status >= 300 && status < 400) {
            conn.disconnect();
            return json(502, "{\"detail\":\"FPL redirected the request, which usually means your login was not accepted. Log in again.\"}");
        }
        if (status < 200 || status > 599) status = 502;
        InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
        if (in == null) in = new ByteArrayInputStream(new byte[0]);

        String mime = "application/json";
        String charset = "utf-8";
        String type = conn.getContentType();
        if (type != null) {
            String[] parts = type.split(";");
            if (!parts[0].trim().isEmpty()) mime = parts[0].trim();
            for (String part : parts) {
                String p = part.trim();
                if (p.toLowerCase(Locale.ROOT).startsWith("charset=")) charset = p.substring(8);
            }
        }
        return new WebResourceResponse(mime, charset, status, reason(status), noStore(), in);
    }

    // ------------------------------------------------------------ app files

    private WebResourceResponse asset(String path) {
        String rel = path.equals("/") ? "index.html" : path.substring(1);
        if (rel.contains("..")) return text(404, "text/plain", "Not found");
        try {
            InputStream in = context.getAssets().open("www/" + rel);
            return new WebResourceResponse(mimeFor(rel), "utf-8", 200, "OK", noStore(), in);
        } catch (IOException e) {
            return text(404, "text/plain", "Not found");
        }
    }

    private static String mimeFor(String file) {
        String f = file.toLowerCase(Locale.ROOT);
        if (f.endsWith(".html")) return "text/html";
        if (f.endsWith(".js")) return "text/javascript";
        if (f.endsWith(".css")) return "text/css";
        if (f.endsWith(".svg")) return "image/svg+xml";
        if (f.endsWith(".png")) return "image/png";
        if (f.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    // ------------------------------------------------------------ helpers

    private static String header(WebResourceRequest request, String wanted) {
        for (Map.Entry<String, String> h : request.getRequestHeaders().entrySet()) {
            if (h.getKey().equalsIgnoreCase(wanted)) return h.getValue();
        }
        return null;
    }

    private static Map<String, String> noStore() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return headers;
    }

    private static String reason(int status) {
        if (status == 204) return "No Content";
        if (status < 300) return "OK";
        if (status == 401) return "Unauthorized";
        if (status == 403) return "Forbidden";
        if (status == 404) return "Not Found";
        return "Error";
    }

    private static WebResourceResponse text(int status, String mime, String body) {
        return new WebResourceResponse(mime, "utf-8", status, reason(status), noStore(),
                new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    private static WebResourceResponse json(int status, String body) {
        return text(status, "application/json", body);
    }

    private static WebResourceResponse empty(int status) {
        return new WebResourceResponse("text/plain", "utf-8", status, reason(status), noStore(),
                new ByteArrayInputStream(new byte[0]));
    }
}
