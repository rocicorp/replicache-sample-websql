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
    return new WebSQLTransaction(this._getDB(), false);
  }

  async withRead<R>(
    f: (read: ExperimentalKVRead) => R | Promise<R>
  ): Promise<R> {
    return await f(await this.read());
  }

  async write(): Promise<ExperimentalKVWrite> {
    return new WebSQLTransaction(this._getDB(), true);
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

class WebSQLTransaction implements ExperimentalKVRead {
  private _tx: Promise<SQLTransaction> | undefined;
  private _cache: Map<
    string,
    { value: ReadonlyJSONValue | undefined; dirty: boolean }
  > = new Map();

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
    return (await this.get(key)) !== undefined;
  }

  async get(key: string): Promise<ReadonlyJSONValue | undefined> {
    const cacheEntry = this._cache.get(key);
    if (cacheEntry !== undefined) {
      return cacheEntry.value;
    }

    const res = await executeSQL(
      await this._getTX(),
      `select v from entry where k = ?`,
      [key]
    );

    const value =
      res.rows.length === 0 ? undefined : JSON.parse(res.rows.item(0).v);
    this._cache.set(key, { value, dirty: false });
    return value;
  }

  get closed(): boolean {
    return this._tx === undefined;
  }

  async put(key: string, value: ReadonlyJSONValue): Promise<void> {
    console.log("put", key, value);
    this._cache.set(key, { value, dirty: true });
  }

  async del(key: string): Promise<void> {
    console.log("del", key);
    this._cache.set(key, { value: undefined, dirty: true });
  }

  release(): void {
    this._tx = undefined;
  }

  async commit(): Promise<void> {
    const tx = await this._getTX();
    console.log("committing pending list", this._cache);
    await Promise.all(
      [...this._cache.entries()]
        .filter(([, entry]) => entry.dirty)
        .map(async ([key, entry]) => {
          const { value } = entry;
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
