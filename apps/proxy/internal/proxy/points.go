package proxy

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

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

	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()
	q := s.db.WithTx(tx)
	if err := ensurePointBalanceTx(ctx, q, userID, now); err != nil {
		return nil, false, err
	}

	balanceAfter, err := q.DebitPointBalance(ctx, appdb.DebitPointBalanceParams{
		Balance:   reservation.Amount,
		UpdatedAt: now,
		UserID:    userID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, nil
		}
		return nil, false, err
	}

	err = q.InsertPointTransaction(ctx, appdb.InsertPointTransactionParams{
		ID:           reservation.DebitID,
		UserID:       userID,
		Amount:       -reservation.Amount,
		Type:         "roaming_debit",
		BalanceAfter: balanceAfter,
		CreatedAt:    now,
	})
	if err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	committed = true

	return reservation, true, nil
}

func (s *Service) refundRoamingPoint(ctx context.Context, reservation *pointReservation) {
	if reservation == nil || reservation.UserID == "" || reservation.Amount <= 0 {
		return
	}

	now := time.Now()
	idempotencyKey := "roaming_refund:" + reservation.DebitID

	_ = func() error {
		tx, err := s.db.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		committed := false
		defer func() {
			if !committed {
				_ = tx.Rollback(ctx)
			}
		}()
		q := s.db.WithTx(tx)
		if err := ensurePointBalanceTx(ctx, q, reservation.UserID, now); err != nil {
			return err
		}

		transactionID := appdb.NewID()
		affected, err := q.InsertPointTransactionOnConflictDoNothing(ctx, appdb.InsertPointTransactionOnConflictDoNothingParams{
			ID:             transactionID,
			UserID:         reservation.UserID,
			Amount:         reservation.Amount,
			Type:           "roaming_refund",
			BalanceAfter:   0,
			IdempotencyKey: &idempotencyKey,
			CreatedAt:      now,
		})
		if err != nil {
			return err
		}
		if affected == 0 {
			committed = true
			return tx.Commit(ctx)
		}

		balanceAfter, err := q.CreditPointBalance(ctx, appdb.CreditPointBalanceParams{
			Balance:   reservation.Amount,
			UpdatedAt: now,
			UserID:    reservation.UserID,
		})
		if err != nil {
			return err
		}

		if err := q.UpdatePointTransactionBalance(ctx, appdb.UpdatePointTransactionBalanceParams{
			BalanceAfter: balanceAfter,
			ID:           transactionID,
		}); err != nil {
			return err
		}
		committed = true
		return tx.Commit(ctx)
	}()
}

func (s *Service) creditSharingPoint(ctx context.Context, ownerUserID, debitID string, amount int) {
	if ownerUserID == "" || debitID == "" || amount <= 0 {
		return
	}

	now := time.Now()
	idempotencyKey := "sharing_credit:" + debitID
	_ = func() error {
		tx, err := s.db.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		committed := false
		defer func() {
			if !committed {
				_ = tx.Rollback(ctx)
			}
		}()
		q := s.db.WithTx(tx)
		if err := ensurePointBalanceTx(ctx, q, ownerUserID, now); err != nil {
			return err
		}

		transactionID := appdb.NewID()
		affected, err := q.InsertPointTransactionOnConflictDoNothing(ctx, appdb.InsertPointTransactionOnConflictDoNothingParams{
			ID:             transactionID,
			UserID:         ownerUserID,
			Amount:         amount,
			Type:           "sharing_credit",
			BalanceAfter:   0,
			IdempotencyKey: &idempotencyKey,
			CreatedAt:      now,
		})
		if err != nil {
			return err
		}
		if affected == 0 {
			committed = true
			return tx.Commit(ctx)
		}

		balanceAfter, err := q.CreditPointBalance(ctx, appdb.CreditPointBalanceParams{
			Balance:   amount,
			UpdatedAt: now,
			UserID:    ownerUserID,
		})
		if err != nil {
			return err
		}

		if err := q.UpdatePointTransactionBalance(ctx, appdb.UpdatePointTransactionBalanceParams{
			BalanceAfter: balanceAfter,
			ID:           transactionID,
		}); err != nil {
			return err
		}
		committed = true
		return tx.Commit(ctx)
	}()
}

func ensurePointBalanceTx(ctx context.Context, q *appdb.Queries, userID string, now time.Time) error {
	affected, err := q.InsertPointBalanceOnConflictDoNothing(ctx, appdb.InsertPointBalanceOnConflictDoNothingParams{
		UserID:    userID,
		Balance:   initialPointBalance,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		return err
	}

	if affected > 0 {
		idempotencyKey := fmt.Sprintf("initial:%s", userID)
		_, err = q.InsertPointTransactionOnConflictDoNothing(ctx, appdb.InsertPointTransactionOnConflictDoNothingParams{
			ID:             appdb.NewID(),
			UserID:         userID,
			Amount:         initialPointBalance,
			Type:           "initial_grant",
			BalanceAfter:   initialPointBalance,
			IdempotencyKey: &idempotencyKey,
			CreatedAt:      now,
		})
		return err
	}

	return nil
}

var errInsufficientPoints = errors.New("insufficient points")
