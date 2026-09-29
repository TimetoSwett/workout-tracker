package com.tuckerswett.workouttracker;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.tuckerswett.workouttracker.healthconnect.HealthConnectPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HealthConnectPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
