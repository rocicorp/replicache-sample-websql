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
    return new WebSQLRead(this._getDB());
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

  constructor(db: Database) {
    this._tx = transact(db, false);
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
      `select 1 from entry where key = ?`,
      [key]
    );
    return res.rows.length > 0;
  }

  async get(key: string): Promise<ReadonlyJSONValue | undefined> {
    const res = await executeSQL(
      await this._getTX(),
      `select value from entry where key = ?`,
      [key]
    );
    if (res.rows.length === 0) {
      return undefined;
    }
    return JSON.parse(res.rows.item(0).value);
  }

  get closed(): boolean {
    return this._tx === undefined;
  }

  release(): void {
    this._tx = undefined;
  }
}

class WebSQLWrite extends WebSQLRead implements ExperimentalKVWrite {
  async put(key: string, value: ReadonlyJSONValue): Promise<void> {
    // TODO: would be better to use upsert probably:
    // https://www.sqlite.org/lang_UPSERT.html
    const has = await this.has(key);
    const str = JSON.stringify(value);
    if (has) {
      await executeSQL(
        await this._getTX(),
        `update entry set value = ? where key = ?`,
        [key, str]
      );
    } else {
      await executeSQL(
        await this._getTX(),
        `insert into entry (key, value) values (?, ?)`,
        [key, str]
      );
    }
  }
  async del(key: string): Promise<void> {
    await executeSQL(await this._getTX(), `delete from entry where key = ?`, [
      key,
    ]);
  }

  async commit(): Promise<void> {
    // nothing to do
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
          `create table entry (key text primary key, value text)`,
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
    tx.executeSql(
      sql,
      args,
      (_, result) => {
        res(result);
      },
      (_, err) => {
        rej(err);
        return true;
      }
    );
  });
}
