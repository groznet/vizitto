#!/usr/bin/env node
/**
 * Assertions for the parsing primitives in build.mjs — the pieces the real
 * sheet's messy cells depend on. Run: node scripts/selftest.mjs
 */
import assert from 'node:assert/strict';
import { parseCsv, slugify, normalisePhone, typographize, csvUrl } from './build.mjs';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

t('parses a plain row', () => {
  assert.deepEqual(parseCsv('a,b,c\r\n1,2,3\r\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
});

t('keeps commas inside quotes', () => {
  assert.deepEqual(parseCsv('a,b\r\n"ул. Ростовская, 11А",x\r\n')[1], ['ул. Ростовская, 11А', 'x']);
});

t('keeps newlines inside quotes', () => {
  const rows = parseCsv('phone,site\r\n"89287895730\n89634282053",https://x.ru\r\n');
  assert.equal(rows[1][0], '89287895730\n89634282053');
  assert.equal(rows[1][1], 'https://x.ru');
});

t('unescapes doubled quotes', () => {
  assert.equal(parseCsv('t\r\n"ТД ""Баркалла"""\r\n')[1][0], 'ТД "Баркалла"');
});

t('keeps empty trailing fields', () => {
  assert.deepEqual(parseCsv('a,b,c\r\n1,,\r\n')[1], ['1', '', '']);
});

t('drops fully blank rows', () => {
  assert.equal(parseCsv('a,b\r\n1,2\r\n,\r\n\r\n').length, 2);
});

t('strips a BOM', () => {
  assert.equal(parseCsv('﻿id,title\r\n1,x\r\n')[0][0], 'id');
});

t('transliterates the -ый ending to a single y', () => {
  assert.equal(slugify('Грозный'), 'grozny');
  assert.equal(slugify('Нижний'), 'nizhny');
});

t('transliterates titles to kebab-case latin', () => {
  assert.equal(slugify('Кондитерская Сафия'), 'konditerskaya-safiya');
  assert.equal(slugify('ТД "Баркалла"'), 'td-barkalla');
  assert.equal(slugify('  Шкафы-купе  '), 'shkafy-kupe');
});

t('normalises Russian phone formats to +7', () => {
  assert.equal(normalisePhone('89287895730'), '+79287895730');
  assert.equal(normalisePhone('+7 928 789 57 30'), '+79287895730');
  assert.equal(normalisePhone('8 (8712) 29-61-63'), '+78712296163');
  assert.equal(normalisePhone('9287895730'), '+79287895730');
});

t('rejects phone junk rather than inventing digits', () => {
  assert.equal(normalisePhone('позвоните нам'), null);
  assert.equal(normalisePhone('123'), null);
  assert.equal(normalisePhone(''), null);
});

t('undoes scientific notation from gviz', () => {
  assert.equal(normalisePhone('8.928789573E10'), '+79287895730');
});

t('converts paired straight quotes to ёлочки', () => {
  assert.equal(typographize('ТД "Баркалла"'), 'ТД «Баркалла»');
  assert.equal(typographize('"Исцеляющие руки"'), '«Исцеляющие руки»');
  assert.equal(typographize('ТРЦ "Беркат", 34 блок'), 'ТРЦ «Беркат», 34 блок');
});

t('leaves an unmatched quote alone rather than guessing', () => {
  assert.equal(typographize('ТД "Баркалла'), 'ТД "Баркалла');
  assert.equal(typographize('без кавычек'), 'без кавычек');
  assert.equal(typographize(null), null);
});

t('cards tab never goes through gviz (it coerces types and blanks cells)', () => {
  const url = csvUrl('SHEET', { name: 'List', gid: null });
  assert.ok(url.includes('/export?format=csv'), url);
  assert.ok(!url.includes('gviz'), url);
});

t('a known gid addresses the tab exactly', () => {
  assert.equal(csvUrl('SHEET', { name: 'List', gid: 0 }),
    'https://docs.google.com/spreadsheets/d/SHEET/export?format=csv&gid=0');
  assert.equal(csvUrl('SHEET', { name: 'Helpers', gid: 12345 }),
    'https://docs.google.com/spreadsheets/d/SHEET/export?format=csv&gid=12345');
});

t('text-only tabs may fall back to gviz by name', () => {
  const url = csvUrl('SHEET', { name: 'Helpers', gid: null }, { allowGvizFallback: true });
  assert.ok(url.includes('gviz') && url.includes('sheet=Helpers'), url);
});

console.log(`\n${passed} assertions passed.`);
