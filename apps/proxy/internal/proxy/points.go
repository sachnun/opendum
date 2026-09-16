package proxy

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"

	appdb "github.com/opendum/opendum/apps/proxy/internal/db"
)

const (
	initialPointBalance  = 15
	roamingMinimumPoints = 1
	pointsPerMillion     = 1_000_000
)

type pointReservation struct {
	UserID  string
	Model   string
	Amount  int
	DebitID string
}

// roamingPoints converts token usage into points using the model's price,
// which is stored as points per million tokens. Successful roaming requests
// cost at least roamingMinimumPoints.
func (s *Service) roamingPoints(model string, usage *usageCounts) int {
	points := 0.0
	if usage != nil && s.registry != nil {
		if cost := s.registry.ModelCost(model); cost != nil {
			billableInput := usage.inputTokens - usage.cachedTokens
			if billableInput < 0 {
				billableInput = 0
			}
			points = (float64(billableInput)*cost.Input +
				float64(usage.cachedTokens)*cost.CacheRead +
				float64(usage.outputTokens)*cost.Output +
				float64(usage.cacheWriteTokens)*cost.CacheWrite) / pointsPerMillion
		}
	}
	total := int(math.Ceil(points))
	if total < roamingMinimumPoints {
		total = roamingMinimumPoints
	}
	return total
}

func (s *Service) reserveRoamingPoint(ctx context.Context, userID, model string) (*pointReservation, bool, error) {
	if userID == "" {
		return nil, true, nil
	}

	reservation := &pointReservation{
		UserID:  userID,
		Model:   model,
		Amount:  roamingMinimumPoints,
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

// adjustRoamingPoints settles the difference between the amount held when the
// roaming request started and the points the request actually cost. A positive
// delta debits the difference and may push the balance negative; a negative
// delta refunds it.
func (s *Service) adjustRoamingPoints(ctx context.Context, reservation *pointReservation, points int) {
	if reservation == nil || reservation.UserID == "" {
		return
	}
	delta := points - reservation.Amount
	if delta == 0 {
		return
	}

	now := time.Now()
	idempotencyKey := "roaming_settle:" + reservation.DebitID
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
			Amount:         -delta,
			Type:           "roaming_settle",
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

		var balanceAfter int
		if delta > 0 {
			balanceAfter, err = q.DebitPointBalanceAllowNegative(ctx, appdb.DebitPointBalanceAllowNegativeParams{
				Balance:   delta,
				UpdatedAt: now,
				UserID:    reservation.UserID,
			})
		} else {
			balanceAfter, err = q.CreditPointBalance(ctx, appdb.CreditPointBalanceParams{
				Balance:   -delta,
				UpdatedAt: now,
				UserID:    reservation.UserID,
			})
		}
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

func (s *Service) settleRoamingPoint(ctx context.Context, ownerUserID string, reservation *pointReservation, model string, usage *usageCounts) {
	if reservation == nil {
		return
	}
	points := s.roamingPoints(model, usage)
	s.adjustRoamingPoints(ctx, reservation, points)
	s.creditSharingPoint(ctx, ownerUserID, reservation.DebitID, points)
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
