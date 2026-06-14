import type { Database } from "bun:sqlite";
import type { DeliveryOutcome } from "@repo/types";

/**
 * Records a new delivery. Returns 'new' if first time seen, 'dup' if already processed.
 * Uses INSERT OR IGNORE so the operation is idempotent.
 */
export function recordDelivery(
  db: Database,
  deliveryId: string,
  event: string,
  action: string | null,
): "new" | "dup" {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO delivery_log (delivery_id, event, action, received_at, outcome)
     VALUES (?, ?, ?, ?, 'applied')`,
  );
  const result = stmt.run(deliveryId, event, action, now);
  // changes() returns 1 if row was inserted, 0 if ignored (duplicate)
  return result.changes > 0 ? "new" : "dup";
}

/**
 * Updates the outcome and processed_at for a delivery after processing.
 */
export function markOutcome(db: Database, deliveryId: string, outcome: DeliveryOutcome): void {
  const now = new Date().toISOString();
  db.prepare(`UPDATE delivery_log SET outcome = ?, processed_at = ? WHERE delivery_id = ?`).run(
    outcome,
    now,
    deliveryId,
  );
}
