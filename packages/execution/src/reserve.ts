import { integer, OrderValidationError } from './order.js';

/** Caller supplies headroom already net of venue resting-order reservations. */
export function assertReservation(costsMicros: number[], availableCashMicros: number, remainingAuthorizationMicros: number): number {
  integer(availableCashMicros, 'available collateral');
  integer(remainingAuthorizationMicros, 'remaining spend authorization');
  const total = costsMicros.reduce((sum, cost) => integer(sum + integer(cost, 'order reservation'), 'basket reservation'), 0);
  if (total > availableCashMicros) throw new OrderValidationError('Basket exceeds available collateral after reservations');
  if (total > remainingAuthorizationMicros) throw new OrderValidationError('Basket exceeds the authorized maximum spend');
  return total;
}
