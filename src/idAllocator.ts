import { Pool } from "pg";

const BLOCK_SIZE = 1000n;

export class IdAllocator {
  private next = 0n;
  private end = 0n; // exclusive
  private refilling: Promise<void> | null = null;

  constructor(private pool: Pool) {}

  private async refill(): Promise<void> {
    const { rows } = await this.pool.query("SELECT nextval('urls_id_seq') AS id");
    this.next = BigInt(rows[0].id);
    this.end = this.next + BLOCK_SIZE;
  }

  async nextId(): Promise<bigint> {
    while (this.next >= this.end) {
      if (!this.refilling) {
        this.refilling = this.refill().finally(() => {
          this.refilling = null;
        });
      }
      await this.refilling;
    }
    return this.next++;
  }
}