import { existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { Lang } from '@shared/i18n'

const DATA = {
  en: {
    family: ['Smith', 'Garcia', 'Kim', 'Johnson', 'Lee', 'Brown', 'Nguyen', 'Patel', 'Lopez', 'Wilson', 'Chen', 'Taylor'],
    given: ['Olivia', 'Liam', 'Emma', 'Noah', 'Ava', 'Mia', 'Lucas', 'Sofia', 'Ethan', 'Zoe', 'Mason', 'Aria', 'Leo', 'Chloe'],
    cities: ['Seattle', 'Austin', 'Boston', 'Denver', 'Chicago', 'Portland', 'Miami', 'Atlanta'],
    grades: ['Basic', 'Basic', 'Basic', 'Silver', 'Gold', 'VIP'],
    statuses: ['done', 'done', 'done', 'done', 'shipping', 'cancelled'],
    products: [
      ['Americano', 'Drinks', 4.5], ['Latte', 'Drinks', 5], ['Matcha latte', 'Drinks', 5.5], ['Lemonade', 'Drinks', 5.8],
      ['Croissant', 'Bakery', 3.8], ['Bagel', 'Bakery', 3.5], ['Cheesecake', 'Dessert', 6.5], ['Tiramisu', 'Dessert', 7],
      ['Macaron', 'Dessert', 2.5], ['Beans 200g', 'Goods', 15], ['Drip bag set', 'Goods', 12], ['Mug', 'Goods', 18],
      ['Tumbler', 'Goods', 25], ['Sandwich', 'Food', 7.5], ['Salad', 'Food', 8.5]
    ] as [string, string, number][],
    fullName: (family: string, given: string) => `${given} ${family}`,
    priceType: 'REAL'
  },
  ko: {
    family: ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오'],
    given: ['민준', '서연', '도윤', '지우', '하준', '서윤', '시우', '하은', '지호', '수아', '예준', '지민', '유진', '현우'],
    cities: ['서울', '부산', '대구', '인천', '광주', '대전', '수원', '제주'],
    grades: ['일반', '일반', '일반', '실버', '골드', 'VIP'],
    statuses: ['완료', '완료', '완료', '완료', '배송중', '취소'],
    products: [
      ['아메리카노', '음료', 4500], ['카페라테', '음료', 5000], ['녹차라테', '음료', 5500], ['레몬에이드', '음료', 5800],
      ['크루아상', '베이커리', 3800], ['베이글', '베이커리', 3500], ['치즈케이크', '디저트', 6500], ['티라미수', '디저트', 7000],
      ['마카롱', '디저트', 2500], ['원두 200g', '상품', 15000], ['드립백 세트', '상품', 12000], ['머그컵', '상품', 18000],
      ['텀블러', '상품', 25000], ['샌드위치', '푸드', 7500], ['샐러드', '푸드', 8500]
    ] as [string, string, number][],
    fullName: (family: string, given: string) => family + given,
    priceType: 'INTEGER'
  }
}

/** Small, slightly messy café database so the health check has something to find. */
export function createSampleDb(file: string, lang: Lang = 'en'): void {
  const d = DATA[lang] ?? DATA.en
  if (existsSync(file)) rmSync(file)
  const db = new DatabaseSync(file)
  let seed = 42
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))
  const day = (y: string): string => `${y}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`

  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT, email TEXT, grade TEXT, joined TEXT);
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT, price ${d.priceType});
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id),
      product_id INTEGER REFERENCES products(id),
      qty INTEGER,
      order_date TEXT,
      status TEXT
    );
  `)

  db.exec('BEGIN')
  const addCustomer = db.prepare('INSERT INTO customers (name, city, email, grade, joined) VALUES (?, ?, ?, ?, ?)')
  for (let i = 1; i <= 60; i++) {
    const city = rand() < 0.1 ? null : pick(d.cities)
    const email = rand() < 0.08 ? '' : `user${i}@example.com`
    addCustomer.run(d.fullName(pick(d.family), pick(d.given)), city, email, pick(d.grades), day(`202${int(2, 6)}`))
  }
  // a couple of accidental duplicates
  db.exec(`INSERT INTO customers (name, city, email, grade, joined) SELECT name, city, email, grade, joined FROM customers WHERE id IN (3, 17)`)

  const addProduct = db.prepare('INSERT INTO products (name, category, price) VALUES (?, ?, ?)')
  for (const p of d.products) addProduct.run(...p)

  const addOrder = db.prepare('INSERT INTO orders (customer_id, product_id, qty, order_date, status) VALUES (?, ?, ?, ?, ?)')
  for (let i = 0; i < 500; i++) {
    const date = `2026-${String(int(1, 9)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`
    addOrder.run(int(1, 60), int(1, d.products.length), rand() < 0.03 ? null : int(1, 4), date, pick(d.statuses))
  }
  db.exec('COMMIT')
  db.close()
}
