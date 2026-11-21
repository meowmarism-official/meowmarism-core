const test = require('node:test');
const assert = require('node:assert');
const sql = require('../modules/db-sql');

test('names are validated, values are escaped', () => {
  assert.strictEqual(sql.ident('players_2'), '`players_2`');
  for (const bad of ['a b', 'x`; DROP', '', 'a-b', 'é', 'x'.repeat(65), null, 5]) assert.throws(() => sql.ident(bad), /invalid name/);
  assert.strictEqual(sql.str("it's"), "'it''s'");
  assert.strictEqual(sql.str('a\\b'), "'a\\\\b'");
  assert.strictEqual(sql.str('a\0b'), "'ab'");
  assert.deepStrictEqual([sql.literal(null), sql.literal(true), sql.literal(7), sql.literal('x')], ['NULL', '1', '7', "'x'"]);
  assert.throws(() => sql.literal(NaN), /invalid number/);
});

test('a hostile value cannot leave its string', () => {
  const evil = "x'; DROP TABLE users; -- \\";
  const out = sql.insertRow('t', { a: evil });
  assert.strictEqual(out, "INSERT INTO `t` (`a`) VALUES ('x''; DROP TABLE users; -- \\\\')");
});

test('instance database names are short and safe', () => {
  assert.strictEqual(sql.instanceDbName('survival'), 'srv_survival');
  const long = sql.instanceDbName('a'.repeat(80));
  assert.ok(long.length <= 32 && /^[A-Za-z0-9_]+$/.test(long));
  assert.notStrictEqual(long, sql.instanceDbName('a'.repeat(81)));
  assert.strictEqual(sql.instanceDbName('my-server'), 'srv_my_server');
});

test('creating a database grants its user that database only', () => {
  const statements = sql.createDatabase({ db: 'srv_a', user: 'srv_a', password: "pw'x" });
  assert.match(statements[0], /^CREATE DATABASE IF NOT EXISTS `srv_a`/);
  assert.ok(statements.some((s) => s === "GRANT ALL PRIVILEGES ON `srv_a`.* TO 'srv_a'@'%'"));
  assert.ok(statements.some((s) => s.includes("IDENTIFIED BY 'pw''x'")));
  assert.throws(() => sql.createDatabase({ db: 'a', user: "x'; --", password: 'p' }), /invalid user/);
  assert.deepStrictEqual(sql.dropDatabase({ db: 'srv_a', user: 'srv_a' }).slice(0, 2), ['DROP DATABASE IF EXISTS `srv_a`', "DROP USER IF EXISTS 'srv_a'@'%'"]);
});

test('tables are built from a spec with whitelisted types', () => {
  const out = sql.createTable({
    name: 'players',
    columns: [
      { name: 'id', type: 'bigint', nullable: false, autoIncrement: true },
      { name: 'name', type: 'varchar', size: 16, nullable: false },
      { name: 'balance', type: 'decimal', default: 0 },
      { name: 'seen', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
    ],
    primaryKey: ['id'],
  });
  assert.strictEqual(out, 'CREATE TABLE `players` (`id` BIGINT NOT NULL AUTO_INCREMENT, `name` VARCHAR(16) NOT NULL, `balance` DECIMAL(10,2) NULL DEFAULT 0, `seen` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
  assert.throws(() => sql.createTable({ name: 't', columns: [{ name: 'a', type: 'int); DROP TABLE x; --' }] }), /unsupported column type/);
  assert.throws(() => sql.createTable({ name: 't', columns: [{ name: 'a', type: 'varchar', size: '1);x' }] }), /invalid column size/);
  assert.throws(() => sql.createTable({ name: 't', columns: [{ name: 'a', type: 'int' }, { name: 'a', type: 'int' }] }), /unique/);
  assert.throws(() => sql.createTable({ name: 't', columns: [{ name: 'a', type: 'int' }], primaryKey: ['b'] }), /does not exist/);
  assert.throws(() => sql.createTable({ name: 't', columns: [] }), /at least one/);
});

test('rows are read in bounded pages and changed by their key', () => {
  assert.strictEqual(sql.selectRows('t', { limit: 10, offset: 20 }), 'SELECT * FROM `t` LIMIT 10 OFFSET 20');
  assert.strictEqual(sql.selectRows('t', { limit: 99999 }), 'SELECT * FROM `t` LIMIT 500 OFFSET 0');
  assert.strictEqual(sql.selectRows('t', { limit: 'x', offset: -4 }), 'SELECT * FROM `t` LIMIT 50 OFFSET 0');
  assert.strictEqual(sql.updateRow('t', { id: 3 }, { name: 'a' }), "UPDATE `t` SET `name` = 'a' WHERE `id` = 3 LIMIT 1");
  assert.strictEqual(sql.deleteRow('t', { id: 3, k: null }), 'DELETE FROM `t` WHERE `id` = 3 AND `k` IS NULL LIMIT 1');
  assert.throws(() => sql.deleteRow('t', {}), /primary key/);
  assert.throws(() => sql.updateRow('t', { id: 1 }, {}), /nothing to change/);
  assert.strictEqual(sql.insertRow('t', {}), 'INSERT INTO `t` () VALUES ()');
});

test('column changes and table removal', () => {
  assert.strictEqual(sql.addColumn('t', { name: 'x', type: 'int' }), 'ALTER TABLE `t` ADD COLUMN `x` INT NULL');
  assert.strictEqual(sql.dropColumn('t', 'x'), 'ALTER TABLE `t` DROP COLUMN `x`');
  assert.strictEqual(sql.dropTable('t'), 'DROP TABLE `t`');
});

test('batch output becomes columns and rows, with escapes undone and NULL kept apart', () => {
  const out = sql.parseBatch('id\tname\tnote\n1\tSteve\tNULL\n2\ta\\tb\tline\\nbreak\n');
  assert.deepStrictEqual(out.columns, ['id', 'name', 'note']);
  assert.deepStrictEqual(out.rows, [['1', 'Steve', null], ['2', 'a\tb', 'line\nbreak']]);
  assert.deepStrictEqual(sql.parseBatch(''), { columns: [], rows: [] });
  assert.deepStrictEqual(sql.parseBatch('n\n'), { columns: ['n'], rows: [] });
});

test('generated passwords are long and URL safe', () => {
  assert.match(sql.newPassword(), /^[A-Za-z0-9_-]{24}$/);
  assert.notStrictEqual(sql.newPassword(), sql.newPassword());
});
