package db

func ProviderAccountFromCredentials(row GetAccountCredentialsByIDRow) ProviderAccount {
	return ProviderAccount{
		ID:           row.ID,
		UserID:       row.UserID,
		Provider:     row.Provider,
		AccessToken:  row.AccessToken,
		RefreshToken: row.RefreshToken,
		ExpiresAt:    row.ExpiresAt,
		AccountID:    row.AccountID,
		ProjectID:    row.ProjectID,
		Tier:         row.Tier,
		Email:        row.Email,
		IsActive:     row.IsActive,
	}
}

func ProviderAccountFromExpiring(row ListExpiringRefreshableAccountsRow) ProviderAccount {
	return ProviderAccount{
		ID:           row.ID,
		UserID:       row.UserID,
		Provider:     row.Provider,
		AccessToken:  row.AccessToken,
		RefreshToken: row.RefreshToken,
		ExpiresAt:    row.ExpiresAt,
		AccountID:    row.AccountID,
		ProjectID:    row.ProjectID,
		Tier:         row.Tier,
		Email:        row.Email,
		IsActive:     row.IsActive,
	}
}

func ProviderAccountFromQuota(row GetQuotaAccountRow) ProviderAccount {
	return ProviderAccount{
		ID:           row.ID,
		UserID:       row.UserID,
		Provider:     row.Provider,
		Name:         row.Name,
		AccessToken:  row.AccessToken,
		RefreshToken: row.RefreshToken,
		ExpiresAt:    row.ExpiresAt,
		APIKey:       row.APIKey,
		ProjectID:    row.ProjectID,
		Tier:         row.Tier,
		AccountID:    row.AccountID,
		Email:        row.Email,
		IsActive:     row.IsActive,
		LastUsedAt:   row.LastUsedAt,
	}
}

func ProviderAccountFromEligible(row ListEligibleAccountsRow) ProviderAccount {
	return ProviderAccount{
		ID:            row.ID,
		UserID:        row.UserID,
		Provider:      row.Provider,
		Tier:          row.Tier,
		AccountID:     row.AccountID,
		Status:        row.Status,
		DisabledUntil: row.DisabledUntil,
		LastUsedAt:    row.LastUsedAt,
		CreatedAt:     row.CreatedAt,
	}
}

func ProviderAccountFromSharedEligible(row ListSharedEligibleAccountsRow) ProviderAccount {
	return ProviderAccount{
		ID:            row.ID,
		UserID:        row.UserID,
		Provider:      row.Provider,
		Tier:          row.Tier,
		AccountID:     row.AccountID,
		Status:        row.Status,
		DisabledUntil: row.DisabledUntil,
		LastUsedAt:    row.LastUsedAt,
		CreatedAt:     row.CreatedAt,
	}
}

func ProviderAccountFromForced(row GetForcedAccountRow) ProviderAccount {
	return ProviderAccount{
		ID:            row.ID,
		UserID:        row.UserID,
		Provider:      row.Provider,
		Tier:          row.Tier,
		AccountID:     row.AccountID,
		Status:        row.Status,
		IsActive:      row.IsActive,
		DisabledUntil: row.DisabledUntil,
		LastUsedAt:    row.LastUsedAt,
		CreatedAt:     row.CreatedAt,
	}
}
