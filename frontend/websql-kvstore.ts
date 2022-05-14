import {
  ExperimentalKVRead,
  ExperimentalKVStore,
  ExperimentalKVWrite,
  ReadonlyJSONValue,
} from "replicache";

export class WebSQLKVStore implements ExperimentalKVStore {
  constructor(win: WindowDatabase, name: string) {
    this._db = open(win, name);
  }

  private _db: Database | undefined;

  private _getDB(): Database {
    if (this._db === undefined) {
      throw new Error("Database is closed");
    }
    return this._db;
  }

  async read(): Promise<ExperimentalKVRead> {
    return new WebSQLRead(this._getDB(), false);
  }

  async withRead<R>(
    f: (read: ExperimentalKVRead) => R | Promise<R>
  ): Promise<R> {
    return await f(await this.read());
  }

  async write(): Promise<ExperimentalKVWrite> {
    return new WebSQLWrite(this._getDB());
  }

  async withWrite<R>(
    f: (write: ExperimentalKVWrite) => R | Promise<R>
  ): Promise<R> {
    return await f(await this.write());
  }

  async close(): Promise<void> {
    this._db = undefined;
  }

  get closed(): boolean {
    return this._db === undefined;
  }
}

class WebSQLRead implements ExperimentalKVRead {
  private _tx: Promise<SQLTransaction> | undefined;
  private _committed = false;

  constructor(db: Database, writeable: boolean) {
    this._tx = transact(db, writeable);
  }

  protected _getTX(): Promise<SQLTransaction> {
    if (this._tx === undefined) {
      throw new Error("Transaction is closed");
    }
    return this._tx;
  }

  async has(key: string): Promise<boolean> {
    const res = await executeSQL(
      await this._getTX(),
      `select 1 from entry where k = ?`,
      [key]
    );
    return res.rows.length > 0;
  }

  async get(key: string): Promise<ReadonlyJSONValue | undefined> {
    const res = await executeSQL(
      await this._getTX(),
      `select v from entry where k = ?`,
      [key]
    );
    if (res.rows.length === 0) {
      return undefined;
    }
    return JSON.parse(res.rows.item(0).v);
  }

  get closed(): boolean {
    return this._tx === undefined;
  }

  release(): void {
    this._tx = undefined;
  }
}

class WebSQLWrite extends WebSQLRead implements ExperimentalKVWrite {
  private _pending: Map<string, ReadonlyJSONValue | undefined> = new Map();

  constructor(db: Database) {
    super(db, true);
  }

  async has(key: string): Promise<boolean> {
    if (this._pending.has(key)) {
      return this._pending.get(key) !== undefined;
    }
    return super.has(key);
  }

  async get(key: string): Promise<ReadonlyJSONValue | undefined> {
    if (this._pending.has(key)) {
      return this._pending.get(key)!;
    }
    return super.get(key);
  }

  async put(key: string, value: ReadonlyJSONValue): Promise<void> {
    console.log("put", key, value);
    this._pending.set(key, value);
  }

  async del(key: string): Promise<void> {
    console.log("del", key);
    this._pending.set(key, undefined);
  }

  async commit(): Promise<void> {
    const tx = await this._getTX();
    console.log("committing pending list", this._pending);
    await Promise.all(
      [...this._pending.entries()].map(async ([key, value]) => {
        console.log("committing", key, value);
        if (value === undefined) {
          await executeSQL(tx, `delete from entry where k = ?`, [key]);
        } else {
          await executeSQL(
            tx,
            `insert or replace into entry (k, v) values (?, ?)`,
            [key, JSON.stringify(value)]
          );
        }
      })
    );
  }
}

function open(win: WindowDatabase, repName: string): Database {
  return win.openDatabase(
    `replicache-${repName}`,
    "1.0",
    "Replicache",
    20 * 1024 * 1024,
    async (db) => {
      if (db === undefined) {
        throw new Error("Failed to open database");
      }
      const tx = await transact(db, true);
      // create table if not exists not supported in chrome, so have to check manually.
      const res = await executeSQL(
        tx,
        `select 1 from sqlite_master where type='table' and name='entry'`,
        undefined
      );
      if (res.rows.length == 0) {
        await executeSQL(
          tx,
          `create table entry (k text primary key, v text)`,
          undefined
        );
      }
    }
  );
}

function transact(db: Database, writeable: boolean): Promise<SQLTransaction> {
  return new Promise((res, rej) => {
    const m = writeable ? db.transaction : db.readTransaction;
    m.apply(db, [(tx) => res(tx), (err) => rej(err)]);
  });
}

function executeSQL(
  tx: SQLTransaction,
  sql: string,
  args: ObjectArray | undefined
): Promise<SQLResultSet> {
  return new Promise(async (res, rej) => {
    console.log(`executing sql: ${sql}`, args);
    tx.executeSql(
      sql,
      args,
      (_, result) => {
        res(result);
      },
      (_, err) => {
        console.error(`Error executing sql: ${sql}`, err, args);
        rej(err);
        return true;
      }
    );
  });
}
