package proxy

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/uptrace/bun"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

const (
	initialPointBalance = 15
	roamingPointCost    = 2
)

type pointReservation struct {
	UserID  string
	Amount  int
	DebitID string
}

func (s *Service) reserveRoamingPoint(ctx context.Context, userID string) (*pointReservation, bool, error) {
	if userID == "" {
		return nil, true, nil
	}

	reservation := &pointReservation{
		UserID:  userID,
		Amount:  roamingPointCost,
		DebitID: appdb.NewID(),
	}
	now := time.Now()

	err := s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if err := ensurePointBalanceTx(ctx, tx, userID, now); err != nil {
			return err
		}

		var balanceAfter int
		err := tx.NewRaw(
			`UPDATE user_point_balance SET balance = balance - ?, "updatedAt" = ? WHERE "userId" = ? AND balance >= ? RETURNING balance`,
			reservation.Amount,
			now,
			userID,
			reservation.Amount,
		).Scan(ctx, &balanceAfter)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return errInsufficientPoints
			}
			return err
		}

		transaction := appdb.PointTransaction{
			ID:           reservation.DebitID,
			UserID:       userID,
			Amount:       -reservation.Amount,
			Type:         "roaming_debit",
			BalanceAfter: balanceAfter,
			CreatedAt:    now,
		}
		_, err = tx.NewInsert().Model(&transaction).Exec(ctx)
		return err
	})
	if err != nil {
		if errors.Is(err, errInsufficientPoints) {
			return nil, false, nil
		}
		return nil, false, err
	}

	return reservation, true, nil
}

func (s *Service) refundRoamingPoint(ctx context.Context, reservation *pointReservation) {
	if reservation == nil || reservation.UserID == "" || reservation.Amount <= 0 {
		return
	}

	now := time.Now()
	idempotencyKey := "roaming_refund:" + reservation.DebitID

	_ = s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if err := ensurePointBalanceTx(ctx, tx, reservation.UserID, now); err != nil {
			return err
		}

		transaction := appdb.PointTransaction{
			ID:             appdb.NewID(),
			UserID:         reservation.UserID,
			Amount:         reservation.Amount,
			Type:           "roaming_refund",
			BalanceAfter:   0,
			IdempotencyKey: &idempotencyKey,
			CreatedAt:      now,
		}
		result, err := tx.NewInsert().Model(&transaction).On("CONFLICT (\"idempotencyKey\") DO NOTHING").Exec(ctx)
		if err != nil {
			return err
		}
		if rows, _ := result.RowsAffected(); rows == 0 {
			return nil
		}

		var balanceAfter int
		if err := tx.NewRaw(
			`UPDATE user_point_balance SET balance = balance + ?, "updatedAt" = ? WHERE "userId" = ? RETURNING balance`,
			reservation.Amount,
			now,
			reservation.UserID,
		).Scan(ctx, &balanceAfter); err != nil {
			return err
		}

		_, err = tx.NewUpdate().Model((*appdb.PointTransaction)(nil)).Set("\"balanceAfter\" = ?", balanceAfter).Where("id = ?", transaction.ID).Exec(ctx)
		return err
	})
}

func (s *Service) creditSharingPoint(ctx context.Context, ownerUserID, debitID string, amount int) {
	if ownerUserID == "" || debitID == "" || amount <= 0 {
		return
	}

	now := time.Now()
	idempotencyKey := "sharing_credit:" + debitID
	_ = s.db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		if err := ensurePointBalanceTx(ctx, tx, ownerUserID, now); err != nil {
			return err
		}

		transaction := appdb.PointTransaction{
			ID:             appdb.NewID(),
			UserID:         ownerUserID,
			Amount:         amount,
			Type:           "sharing_credit",
			BalanceAfter:   0,
			IdempotencyKey: &idempotencyKey,
			CreatedAt:      now,
		}
		result, err := tx.NewInsert().Model(&transaction).On("CONFLICT (\"idempotencyKey\") DO NOTHING").Exec(ctx)
		if err != nil {
			return err
		}
		if rows, _ := result.RowsAffected(); rows == 0 {
			return nil
		}

		var balanceAfter int
		if err := tx.NewRaw(
			`UPDATE user_point_balance SET balance = balance + ?, "updatedAt" = ? WHERE "userId" = ? RETURNING balance`,
			amount,
			now,
			ownerUserID,
		).Scan(ctx, &balanceAfter); err != nil {
			return err
		}

		_, err = tx.NewUpdate().Model((*appdb.PointTransaction)(nil)).Set("\"balanceAfter\" = ?", balanceAfter).Where("id = ?", transaction.ID).Exec(ctx)
		return err
	})
}

func ensurePointBalanceTx(ctx context.Context, tx bun.Tx, userID string, now time.Time) error {
	balance := appdb.UserPointBalance{UserID: userID, Balance: initialPointBalance, CreatedAt: now, UpdatedAt: now}
	result, err := tx.NewInsert().Model(&balance).On("CONFLICT (\"userId\") DO NOTHING").Exec(ctx)
	if err != nil {
		return err
	}

	if rows, _ := result.RowsAffected(); rows > 0 {
		idempotencyKey := fmt.Sprintf("initial:%s", userID)
		transaction := appdb.PointTransaction{
			ID:             appdb.NewID(),
			UserID:         userID,
			Amount:         initialPointBalance,
			Type:           "initial_grant",
			BalanceAfter:   initialPointBalance,
			IdempotencyKey: &idempotencyKey,
			CreatedAt:      now,
		}
		_, err = tx.NewInsert().Model(&transaction).On("CONFLICT (\"idempotencyKey\") DO NOTHING").Exec(ctx)
		return err
	}

	return nil
}

var errInsufficientPoints = errors.New("insufficient points")
