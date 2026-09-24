package psiphon

// buildConfig mirrors the tunnel tuning the unroxy psiphon provider uses:
// a small per-region pool, bounded connection workers, and a fixed
// egress region so every tunnel in the pool exits from the same country.
func buildConfig(dataDir string, poolSize int, region string) map[string]any {
	sshWindowSize := 32
	config := map[string]any{
		"LocalSocksProxyPort":             0,
		"LocalHttpProxyPort":              0,
		"PropagationChannelId":            "FFFFFFFFFFFFFFFF",
		"SponsorId":                       "FFFFFFFFFFFFFFFF",
		"EstablishTunnelTimeoutSeconds":   300,
		"TunnelPoolSize":                  poolSize,
		"DisableDSLFetcher":               true,
		"DataRootDirectory":               dataDir,
		"NetworkID":                       "WIFI",
		"EmitDiagnosticNotices":           true,
		"DisableTactics":                  true,
		"LimitMeekBufferSizes":            false,
		"LimitRelayBufferSizes":           true,
		"LimitCPUThreads":                 true,
		"ConnectionWorkerPoolSize":        2,
		"ConnectionWorkerPoolMaxSize":     2,
		"LimitIntensiveConnectionWorkers": 1,
		"SSHChannelWindowSize":            &sshWindowSize,
		"DisableServerEntriesReporter":    true,
		"DisableReplay":                   true,
		"IgnoreHandshakeStatsRegexps":     true,
		"ServerEntrySignaturePublicKey":   serverEntrySignaturePublicKey,
	}
	if region != "" {
		config["EgressRegion"] = region
	}
	return config
}
