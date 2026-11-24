import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { catalog, day, stages } from "./catalog.ts";
const file = process.env.DORM_DB || resolve("data/dorm.sqlite");
if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
export const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
db.exec(readFileSync(resolve("db/001_initial.sql"), "utf8"));
type V = string | number | null;
export const run = (sql: string, ...v: V[]) => db.prepare(sql).run(...v);
export const one = (sql: string, ...v: V[]): any => db.prepare(sql).get(...v);
export const all = (sql: string, ...v: V[]): any[] => db.prepare(sql).all(...v);
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function insist(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const token = () => randomBytes(32).toString("hex");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const clock = () => Date.now();
export const log = (b: number, u: number | null, e: string) =>
  run(
    "INSERT INTO audit_logs(buy,uid,event,at) VALUES(?,?,?,?)",
    b,
    u,
    e,
    clock(),
  );
export function note(
  u: number,
  b: number,
  s: string,
  key: string | null = null,
) {
  run(
    "INSERT OR IGNORE INTO notifications(uid,buy,body,at,dedupe) SELECT id,?,?,?,? FROM profiles WHERE id=? AND notify=1",
    b,
    s,
    clock(),
    key,
    u,
  );
}
export function broadcast(b: number, s: string) {
  for (const p of all(
    "SELECT owner AS u FROM group_buys WHERE id=? UNION SELECT uid FROM group_buy_participants WHERE buy=? AND active=1",
    b,
    b,
  ))
    note(p.u, b, s);
}
export function state(b: number, u: number | null, s: string) {
  run(
    "UPDATE group_buys SET status=?,closed=CASE WHEN ? IN ('done','failed','stopped') THEN ? ELSE NULL END WHERE id=?",
    s,
    s,
    clock(),
    b,
  );
  broadcast(b, stages[s]);
  log(b, u, stages[s]);
}
export function participant(b: number, u: number, q: number) {
  const pid = Number(
    run(
      "INSERT INTO group_buy_participants(buy,uid,lots) VALUES(?,?,?)",
      b,
      u,
      q,
    ).lastInsertRowid,
  );
  run("INSERT INTO payment_simulations VALUES(?,'demo')", pid);
  run("INSERT INTO pickup_confirmations(pid) VALUES(?)", pid);
  return pid;
}
export function price(b: number) {
  const { price, lots } = one(
    "SELECT i.price,g.lots FROM group_buys g JOIN group_buy_items i ON i.buy=g.id WHERE g.id=?",
    b,
  );
  let offset = 0;
  for (const p of all(
    "SELECT * FROM group_buy_participants WHERE active=1 AND buy=? ORDER BY id",
    b,
  )) {
    const cost =
      Math.floor(((offset + p.lots) * price) / lots) -
      Math.floor((offset * price) / lots);
    run("UPDATE group_buy_participants SET amount=? WHERE id=?", cost, p.id);
    offset += p.lots;
  }
  return offset;
}
export function addBuy(u: number, d: string, x: any) {
  const id = Number(
    run(
      "INSERT INTO group_buys(owner,dorm,status,mode,lots,deadline,order_at,created,kakao) VALUES(?,?,'open',?,?,?,?,?,?)",
      u,
      d,
      x.mode,
      x.lots,
      x.deadline,
      x.orderAt,
      clock(),
      x.kakao || "",
    ).lastInsertRowid,
  );
  run(
    "INSERT INTO group_buy_items VALUES(?,?,?,?,?,?,?)",
    id,
    x.name,
    x.image,
    x.url,
    x.price,
    x.qty,
    x.category,
  );
  run("INSERT INTO pickup_schedules VALUES(?,?,?)", id, x.place, x.pickup);
  run("INSERT INTO chat_rooms VALUES(?)", id);
  log(id, u, "공구 개설");
  return id;
}
function seed(space: string) {
  run("INSERT INTO spaces VALUES(?)", space);
  for (const d of ["A", "B"]) {
    const ids: number[] = [];
    for (const [i, h] of [
      "member",
      "host",
      "operator",
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
    ].entries()) {
      const id = Number(
        run(
          "INSERT INTO profiles(space,handle,name,role) VALUES(?,?,?,?)",
          space,
          d + h,
          (["참여자", "학생 개설자", "운영팀"][i] || "학생 " + i) + " (데모)",
          i === 2 ? "admin" : "student",
        ).lastInsertRowid,
      );
      run("INSERT INTO dormitory_memberships VALUES(?,?)", id, d);
      ids.push(id);
    }
    for (let j = 0; j < 12; j++) {
      const [name, art, cat, cost, qty, lots, n] = catalog[j % 6];
      const status = ["full", "ordered", "shipping", "ready", "done", "failed"][
        j - 6
      ];
      const b = addBuy(ids[j % 6 < 3 ? 2 : 1], d, {
        mode: j % 2 ? "units" : "equal",
        lots,
        deadline: clock() + (j + 1) * day,
        orderAt: clock() + (j + 2) * day,
        pickup: clock() + (j + 4) * day,
        place: d + "기숙사 1층 로비",
        name,
        image: "/art/" + art + ".webp",
        url: "",
        price: cost,
        qty,
        category: cat,
      });
      const people = j < 6 ? n : status === "failed" ? 1 : lots;
      for (let k = 0; k < people; k++) {
        const pid = participant(b, j >= 6 && k === 0 ? ids[0] : ids[3 + k], 1);
        if (status === "done")
          run(
            "UPDATE pickup_confirmations SET student_at=?,host_at=?,host_uid=? WHERE pid=?",
            clock(),
            clock(),
            ids[2],
            pid,
          );
      }
      price(b);
      if (status) {
        run(
          "UPDATE group_buys SET status=?,filled=?,closed=? WHERE id=?",
          status,
          status === "failed" ? null : clock(),
          ["done", "failed"].includes(status) ? clock() : null,
          b,
        );
        if (["ordered", "shipping", "ready", "done"].includes(status))
          run(
            "INSERT INTO orders VALUES(?,?,?)",
            b,
            ids[j % 6 < 3 ? 2 : 1],
            clock(),
          );
        if (status === "failed") voidPayments(b);
      }
    }
  }
}
export function voidPayments(b: number) {
  run(
    "UPDATE payment_simulations SET status='void' WHERE pid IN (SELECT id FROM group_buy_participants WHERE buy=?)",
    b,
  );
}
export function login(
  spaceKey: string,
  account: string,
  dorm: string,
  notify: boolean,
) {
  insist(
    ["member", "host", "operator", "s1", "s2", "s3", "s4", "s5", "s6"].includes(
      account,
    ) && ["A", "B"].includes(dorm),
    "데모 계정과 기숙사를 선택해 주세요.",
  );
  return tx(() => {
    let space = hash(spaceKey);
    if (!spaceKey || !one("SELECT id FROM spaces WHERE id=?", space)) {
      spaceKey = token();
      space = hash(spaceKey);
      seed(space);
    }
    const u = one(
      "SELECT id FROM profiles WHERE space=? AND handle=?",
      space,
      dorm + account,
    );
    run("UPDATE profiles SET notify=? WHERE id=?", +notify, u.id);
    const session = token();
    run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash(session),
      u.id,
      clock() + 7 * day,
    );
    return { session, spaceKey };
  });
}
export const user = (s: string) =>
  one(
    "SELECT p.*,m.dorm FROM sessions s JOIN profiles p ON p.id=s.uid JOIN dormitory_memberships m ON m.uid=p.id WHERE s.token=? AND expires>?",
    hash(s),
    clock(),
  );
export function logout(s: string) {
  run("DELETE FROM sessions WHERE token=?", hash(s));
}
export function sweep() {
  for (const g of all(
    "SELECT * FROM group_buys WHERE status='open' AND deadline<=?",
    clock(),
  )) {
    state(g.id, null, "failed");
    voidPayments(g.id);
  }
  for (const g of all(
    "SELECT g.*,p.space FROM group_buys g JOIN profiles p ON p.id=g.owner WHERE status IN ('full','pending') AND order_at<?",
    clock(),
  )) {
    note(g.owner, g.id, "주문 예정일이 지났어요.", "late" + g.id);
    if (g.order_at + day < clock())
      for (const a of all(
        "SELECT p.id FROM profiles p JOIN dormitory_memberships m ON m.uid=p.id WHERE p.space=? AND role='admin' AND m.dorm=?",
        g.space,
        g.dorm,
      ))
        note(a.id, g.id, "주문이 하루 이상 지연됐어요.", "adminlate" + g.id);
  }
  for (const p of all(
    "SELECT p.uid,p.buy FROM group_buy_participants p JOIN pickup_confirmations c ON c.pid=p.id JOIN pickup_schedules s ON s.buy=p.buy JOIN group_buys g ON g.id=p.buy WHERE active=1 AND g.status='ready' AND s.at<? AND c.student_at IS NULL",
    clock(),
  ))
    note(
      p.uid,
      p.buy,
      "수령 예정일이 지났어요. 재수령 일정을 요청할 수 있어요.",
      "miss" + p.buy + "-" + p.uid,
    );
}
export function accountLogin(input: any, signup: boolean) {
  const handle = String(input.handle || "")
      .trim()
      .toLowerCase(),
    password = input.password;
  insist(
    /^[a-z0-9_-]{4,32}$/.test(handle),
    "아이디는 영문 소문자·숫자 등 4~32자로 입력해 주세요.",
  );
  insist(
    typeof password === "string" &&
      password.length >= 10 &&
      password.length <= 128,
    "비밀번호는 10~128자로 입력해 주세요.",
  );
  const space = "shared-test-campus",
    existing = one(
      "SELECT p.*,c.salt,c.digest FROM profiles p JOIN credentials c ON c.uid=p.id WHERE p.space=? AND p.handle=?",
      space,
      handle,
    );
  let id = existing?.id;
  if (signup) {
    insist(!existing, "이미 등록한 아이디예요.");
    insist(["A", "B"].includes(input.dorm), "기숙사를 선택해 주세요.");
    const salt = token(),
      digest = scryptSync(password, salt, 64).toString("hex");
    id = tx(() => {
      run("INSERT OR IGNORE INTO spaces VALUES(?)", space);
      const u = Number(
        run(
          "INSERT INTO profiles(space,handle,name,role,notify) VALUES(?,?,?,'student',?)",
          space,
          handle,
          handle,
          +!!input.notify,
        ).lastInsertRowid,
      );
      run("INSERT INTO credentials VALUES(?,?,?)", u, salt, digest);
      run("INSERT INTO dormitory_memberships VALUES(?,?)", u, input.dorm);
      return u;
    });
  } else {
    const limit = one("SELECT * FROM login_attempts WHERE handle=?", handle);
    insist(
      !limit || limit.until <= clock() || limit.attempts < 12,
      "잠시 후 다시 시도해 주세요.",
    );
    const digest = scryptSync(password, existing?.salt || "absent-account", 64);
    if (
      !existing ||
      !timingSafeEqual(digest, Buffer.from(existing.digest, "hex"))
    ) {
      run(
        "INSERT OR REPLACE INTO login_attempts VALUES(?,?,?)",
        handle,
        limit && limit.until > clock() ? limit.attempts + 1 : 1,
        limit && limit.until > clock() ? limit.until : clock() + 600000,
      );
      throw Error("아이디와 비밀번호를 확인해 주세요.");
    }
    run("DELETE FROM login_attempts WHERE handle=?", handle);
  }
  const session = token();
  run(
    "INSERT INTO sessions VALUES(?,?,?)",
    hash(session),
    id,
    clock() + 7 * day,
  );
  return session;
}
