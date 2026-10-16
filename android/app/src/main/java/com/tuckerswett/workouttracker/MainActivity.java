package com.tuckerswett.workouttracker;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.tuckerswett.workouttracker.healthconnect.HealthConnectPlugin;
import com.tuckerswett.workouttracker.updates.AppUpdatePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HealthConnectPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
