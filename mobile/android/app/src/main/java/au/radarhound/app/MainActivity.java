package au.radarhound.app;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WxAlertsPlugin.class);
        super.onCreate(savedInstanceState);
        // keep background alerts running if they were switched on before
        var p = getSharedPreferences(AlertService.PREFS, MODE_PRIVATE);
        if (p.getBoolean("enabled", true) && (p.getString("server", null) != null || "phone".equals(p.getString("mode", "server")))) AlertService.start(this);
    }

    @Override
    public void onBackPressed() {
        WebView wv = bridge != null ? bridge.getWebView() : null;
        if (wv != null && wv.canGoBack()) {
            wv.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
