import { z } from "zod";
import {
  all,
  one,
  run,
  tx,
  clock,
  insist,
  addBuy,
  participant,
  price,
  state,
  log,
  note,
  broadcast,
  voidPayments,
  sweep,
} from "./db.ts";
import { day, responsibilities } from "./catalog.ts";
const web = z
  .url()
  .refine((s) => /^https?:\/\//i.test(s), "http(s) 링크를 입력해 주세요.");
const timestamp = z.number().int().positive().max(8640000000000000);
const create = z.object({
  name: z.string().trim().min(1).max(100),
  image: z.union([
    web,
    z
      .string()
      .regex(/^\/art\/(tissue|detergent|wipes|ramen|snacks|pens)\.webp$/),
  ]),
  url: web,
  price: z.number().int().min(1).max(100000000),
  qty: z.number().int().min(1).max(100000),
  lots: z.number().int().min(1).max(10000),
  mode: z.enum(["equal", "units"]),
  deadline: timestamp,
  orderAt: timestamp,
  pickup: timestamp,
  place: z.string().trim().min(1).max(100),
  category: z.enum(["생활용품", "세탁·청소", "식품", "문구", "기타"]),
  kakao: z
    .union([
      z.literal(""),
      z.url().refine((s) => new URL(s).origin === "https://open.kakao.com"),
    ])
    .default(""),
  agree: z.array(z.literal(true)).length(responsibilities.length),
});
const query = `SELECT g.*,i.name,i.image,i.url,i.price,i.qty,i.category,s.place,s.at AS pickup,p.name AS host,p.role='admin' AS official,p.space,
(SELECT coalesce(sum(lots),0) FROM group_buy_participants WHERE buy=g.id AND active=1) AS used,
(SELECT count(*) FROM group_buy_participants WHERE buy=g.id AND active=1) AS people
FROM group_buys g JOIN group_buy_items i ON i.buy=g.id JOIN pickup_schedules s ON s.buy=g.id JOIN profiles p ON p.id=g.owner`;
function group(u: any, id: number) {
  const g = one(
    query + " WHERE g.id=? AND p.space=? AND (g.dorm=? OR ?=1)",
    id,
    u.space,
    u.dorm,
    Number(u.role === "admin"),
  );
  insist(g, "이 기숙사에서 확인할 수 없는 공구예요.");
  return g;
}
const member = (g: number, u: number) =>
  one(
    "SELECT p.*,c.student_at,c.host_at FROM group_buy_participants p JOIN pickup_confirmations c ON c.pid=p.id WHERE p.buy=? AND p.uid=? AND active=1",
    g,
    u,
  );
const manageable = (u: any, g: any) => g.owner === u.id || u.role === "admin";
export function browse(u: any) {
  return tx(() => {
    sweep();
    const groups = all(
      query +
        " WHERE p.space=? AND g.dorm=? ORDER BY (g.status='open') DESC,g.deadline,g.id",
      u.space,
      u.dorm,
    ).map((g) => ({
      ...g,
      space: undefined,
      kakao: undefined,
      mine: !!member(g.id, u.id),
    }));
    return {
      me: {
        id: u.id,
        name: u.name,
        demo: u.space !== "shared-test-campus",
        dorm: u.dorm,
        role: u.role,
        notify: !!u.notify,
      },
      groups,
      notifications: all(
        "SELECT n.*,i.name FROM notifications n JOIN group_buy_items i ON i.buy=n.buy WHERE uid=? ORDER BY n.id DESC LIMIT 100",
        u.id,
      ),
    };
  });
}
export function detail(u: any, id: number) {
  return tx(() => {
    sweep();
    const g = group(u, id),
      mine = member(id, u.id),
      manager = manageable(u, g),
      chat = !!mine || u.id === g.owner;
    return {
      ...g,
      space: undefined,
      mine,
      manager,
      chat,
      kakao: chat ? g.kakao : "",
      history: all(
        "SELECT event,at FROM audit_logs WHERE buy=? ORDER BY id DESC LIMIT 30",
        id,
      ),
      members: manager
        ? all(
            "SELECT p.id,p.uid,p.lots,p.amount,u.name,c.student_at,c.host_at,s.status AS payment FROM group_buy_participants p JOIN profiles u ON u.id=p.uid JOIN pickup_confirmations c ON c.pid=p.id JOIN payment_simulations s ON s.pid=p.id WHERE p.buy=? AND active=1",
            id,
          )
        : [],
      messages: chat
        ? all(
            "SELECT m.id,m.body,m.at,p.name FROM chat_messages m JOIN profiles p ON p.id=m.uid WHERE buy=? ORDER BY m.id",
            id,
          )
        : [],
      issues: all(
        "SELECT * FROM issue_reports WHERE buy=? AND (uid=? OR ?=1) ORDER BY id DESC",
        id,
        u.id,
        +manager,
      ),
      requests: all(
        "SELECT c.*,u.name FROM cancellation_requests c JOIN group_buy_participants p ON p.id=c.pid JOIN profiles u ON u.id=p.uid WHERE p.buy=? AND (p.uid=? OR ?=1)",
        id,
        u.id,
        +manager,
      ),
    };
  });
}
export function admin(u: any) {
  insist(u.role === "admin", "운영자 계정으로 로그인해 주세요.");
  return tx(() => {
    sweep();
    const rows = all(query + " WHERE p.space=?", u.space);
    const entries = all(
      "SELECT r.*,i.name,g.dorm FROM issue_reports r JOIN group_buys g ON g.id=r.buy JOIN profiles p ON p.id=g.owner JOIN group_buy_items i ON i.buy=g.id WHERE p.space=?",
      u.space,
    );
    const participants = all(
      "SELECT t.uid,t.buy FROM group_buy_participants t JOIN profiles p ON p.id=t.uid WHERE p.space=? AND active=1",
      u.space,
    );
    const queue = all(
      "SELECT g.id AS buy,g.dorm,i.name,'취소 요청' AS kind FROM cancellation_requests c JOIN group_buy_participants t ON t.id=c.pid JOIN group_buys g ON g.id=t.buy JOIN group_buy_items i ON i.buy=g.id JOIN profiles p ON p.id=g.owner WHERE p.space=? AND c.result='검토 중' UNION ALL SELECT g.id,g.dorm,i.name,'미수령' FROM group_buys g JOIN group_buy_items i ON i.buy=g.id JOIN profiles p ON p.id=g.owner JOIN pickup_schedules s ON s.buy=g.id WHERE p.space=? AND g.status='ready' AND s.at<? AND EXISTS(SELECT 1 FROM group_buy_participants t JOIN pickup_confirmations c ON c.pid=t.id WHERE t.buy=g.id AND t.active=1 AND c.student_at IS NULL)",
      u.space,
      u.space,
      clock(),
    );
    return {
      queue,
      rows: rows.map(({ space, kakao, ...r }) => r),
      entries,
      participations: participants.length,
      repeat: [...new Set(participants.map((p) => p.uid))].filter(
        (id) => participants.filter((p) => p.uid === id).length > 1,
      ).length,
    };
  });
}
function cancel(b: number, p: any) {
  run("UPDATE group_buy_participants SET active=0 WHERE id=?", p.id);
  run("UPDATE payment_simulations SET status='void' WHERE pid=?", p.id);
  price(b);
}
export function act(u: any, a: any) {
  return tx(() => {
    sweep();
    if (a.action === "seen") {
      run("UPDATE notifications SET seen=1 WHERE uid=?", u.id);
      return {};
    }
    if (a.action === "create") {
      const x = create.safeParse(a);
      insist(x.success, "상품 정보와 링크, 개설자 동의를 확인해 주세요.");
      const v = x.data;
      insist(
        v.qty % v.lots === 0,
        "총 수량을 모집 단위 수로 나눌 수 있어야 해요.",
      );
      insist(
        v.deadline > clock() &&
          v.orderAt >= v.deadline &&
          v.pickup >= v.orderAt,
        "모집 마감, 주문 예정, 수령 예정 순서로 미래 일정을 입력해 주세요.",
      );
      return { id: addBuy(u.id, u.dorm, v) };
    }
    const g = group(u, Number(a.id)),
      id = g.id,
      p = member(id, u.id),
      manager = manageable(u, g);
    const manage = () =>
      insist(manager, "개설자 또는 담당 운영자만 처리할 수 있어요.");
    const before = ["open", "full", "pending"].includes(g.status),
      terminal = ["done", "failed", "stopped"].includes(g.status);
    switch (a.action) {
      case "join": {
        insist(
          u.dorm === g.dorm &&
            !p &&
            g.owner !== u.id &&
            g.status === "open" &&
            g.deadline > clock(),
          "현재 참여할 수 없는 공구예요.",
        );
        insist(
          Number.isInteger(a.lots) &&
            a.lots > 0 &&
            a.lots <= g.lots - g.used &&
            (g.mode === "units" || a.lots === 1),
          "남은 모집 단위 안에서 선택해 주세요.",
        );
        participant(id, u.id, a.lots);
        if (price(id) === g.lots) {
          run("UPDATE group_buys SET filled=? WHERE id=?", clock(), id);
          state(id, u.id, "full");
        }
        log(id, u.id, "공구 참여");
        note(u.id, id, "참여가 확정됐어요.");
        break;
      }
      case "cancel": {
        insist(p && !terminal, "취소할 수 있는 참여 내역이 없어요.");
        if (before) {
          cancel(id, p);
          run(
            "INSERT INTO cancellation_requests(pid,at,result) VALUES(?,?,'취소 완료')",
            p.id,
            clock(),
          );
          run("UPDATE group_buys SET filled=NULL WHERE id=?", id);
          state(id, u.id, g.deadline > clock() ? "open" : "failed");
          if (g.deadline <= clock()) voidPayments(id);
          note(u.id, id, "참여 취소 완료");
        } else {
          insist(
            !one(
              "SELECT id FROM cancellation_requests WHERE pid=? AND result='검토 중'",
              p.id,
            ),
            "이미 접수한 요청이에요.",
          );
          run(
            "INSERT INTO cancellation_requests(pid,at,result) VALUES(?,?,'검토 중')",
            p.id,
            clock(),
          );
          note(g.owner, id, "취소 요청이 접수됐어요.");
          log(id, u.id, "취소 요청 접수");
        }
        break;
      }
      case "resolveCancel": {
        manage();
        const r = one(
          "SELECT c.*,p.uid FROM cancellation_requests c JOIN group_buy_participants p ON p.id=c.pid WHERE c.id=? AND p.buy=? AND result='검토 중'",
          a.request,
          id,
        );
        insist(r, "처리할 요청이 없어요.");
        const result = z.enum(["승인", "반려"]).parse(a.result);
        run(
          "UPDATE cancellation_requests SET result=? WHERE id=?",
          result,
          r.id,
        );
        if (result === "승인") {
          run("UPDATE group_buy_participants SET active=0 WHERE id=?", r.pid);
          run(
            "UPDATE payment_simulations SET status='void' WHERE pid=?",
            r.pid,
          );
        }
        note(r.uid, id, "취소 요청 " + result);
        log(id, u.id, "주문 후 취소 " + result);
        break;
      }
      case "advance": {
        manage();
        const next: Record<string, string> = {
          open: "failed",
          full: "pending",
          pending: "ordered",
          ordered: "shipping",
          shipping: "ready",
          ready: "done",
        };
        insist(
          next[g.status] && a.to === next[g.status],
          "현재 단계에서 가능한 작업을 다시 확인해 주세요.",
        );
        if (a.to === "failed") voidPayments(id);
        if (a.to === "ordered")
          run("INSERT INTO orders VALUES(?,?,?)", id, u.id, clock());
        if (a.to === "ready")
          insist(g.checklist === 31, "분배 준비 항목을 모두 확인해 주세요.");
        if (a.to === "done") {
          insist(
            !one(
              "SELECT c.id FROM cancellation_requests c JOIN group_buy_participants p ON p.id=c.pid WHERE p.buy=? AND c.result='검토 중'",
              id,
            ),
            "접수된 취소 요청을 먼저 처리해 주세요.",
          );
          insist(
            !one(
              "SELECT p.id FROM group_buy_participants p JOIN pickup_confirmations c ON c.pid=p.id WHERE p.buy=? AND active=1 AND (c.student_at IS NULL OR c.host_at IS NULL)",
              id,
            ),
            "모든 참여자와 개설자의 수령 확인이 필요해요.",
          );
          insist(
            !one(
              "SELECT id FROM issue_reports WHERE buy=? AND status='open'",
              id,
            ),
            "접수된 문제를 먼저 처리해 주세요.",
          );
        }
        state(id, u.id, a.to);
        break;
      }
      case "stop":
        insist(
          u.role === "admin" && !terminal,
          "진행 중인 공구만 운영자가 중단할 수 있어요.",
        );
        state(id, u.id, "stopped");
        voidPayments(id);
        break;
      case "check":
        manage();
        insist(
          g.status === "shipping" &&
            Number.isInteger(a.bit) &&
            a.bit >= 0 &&
            a.bit < 5,
          "배송 중에 준비 사항을 확인해 주세요.",
        );
        run(
          "UPDATE group_buys SET checklist=? WHERE id=?",
          a.checked ? g.checklist | (1 << a.bit) : g.checklist & ~(1 << a.bit),
          id,
        );
        break;
      case "receive":
        insist(
          g.status === "ready" && p && !p.student_at,
          "수령 가능한 참여 내역을 확인해 주세요.",
        );
        run(
          "UPDATE pickup_confirmations SET student_at=? WHERE pid=?",
          clock(),
          p.id,
        );
        note(g.owner, id, "참여자가 수령을 확인했어요.");
        log(id, u.id, "참여자 수령 확인");
        break;
      case "handoff": {
        manage();
        const t = one(
          "SELECT c.* FROM pickup_confirmations c JOIN group_buy_participants p ON p.id=c.pid WHERE p.id=? AND buy=? AND active=1",
          a.pid,
          id,
        );
        insist(
          g.status === "ready" && t?.student_at && !t.host_at,
          "참여자의 수령 확인 후 전달을 확인해 주세요.",
        );
        run(
          "UPDATE pickup_confirmations SET host_at=?,host_uid=? WHERE pid=?",
          clock(),
          u.id,
          a.pid,
        );
        log(id, u.id, "개설자 전달 확인");
        break;
      }
      case "chat":
        insist(
          (p || g.owner === u.id) &&
            (!terminal || clock() - g.closed < 7 * day),
          "대화에 메시지를 보낼 수 없어요.",
        );
        run(
          "INSERT INTO chat_messages(buy,uid,body,at) VALUES(?,?,?,?)",
          id,
          u.id,
          z.string().trim().min(1).max(1000).parse(a.body),
          clock(),
        );
        break;
      case "issue": {
        insist(p || g.owner === u.id, "공구 참여 후 문의할 수 있어요.");
        const kind = z
          .enum(["파손", "누락", "재수령 일정", "기타"])
          .parse(a.kind);
        if (kind === "재수령 일정")
          insist(
            g.status === "ready" && !p?.host_at,
            "수령 단계에서 일정을 요청해 주세요.",
          );
        const photo = z
          .string()
          .max(700000)
          .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/)
          .optional()
          .parse(a.photo || undefined);
        run(
          "INSERT INTO issue_reports(buy,uid,kind,body,photo,at) VALUES(?,?,?,?,?,?)",
          id,
          u.id,
          kind,
          z.string().trim().min(1).max(800).parse(a.body),
          photo || null,
          clock(),
        );
        note(g.owner, id, kind + " 요청 접수");
        log(id, u.id, kind + " 접수");
        break;
      }
      case "resolve": {
        manage();
        const r = one(
          "SELECT * FROM issue_reports WHERE id=? AND buy=? AND status='open'",
          a.issue,
          id,
        );
        insist(r, "처리할 문의가 없어요.");
        const result = z.string().trim().min(1).max(800).parse(a.result);
        if (a.dispute === true) {
          insist(
            u.role === "admin" && g.status === "ready",
            "수령 단계의 분쟁은 운영자가 종결할 수 있어요.",
          );
          const affected = member(id, r.uid);
          insist(
            affected && !affected.host_at,
            "미수령 참여자를 확인해 주세요.",
          );
          run(
            "UPDATE group_buy_participants SET active=0 WHERE id=?",
            affected.id,
          );
          run(
            "UPDATE payment_simulations SET status='void' WHERE pid=?",
            affected.id,
          );
          log(id, u.id, "미수령 분쟁 종결");
          note(r.uid, id, "분쟁 종결 · 모의 결제 취소");
        }
        run(
          "UPDATE issue_reports SET status='done',result=? WHERE id=?",
          result,
          r.id,
        );
        note(r.uid, id, r.kind + " 처리 결과 · " + result);
        log(id, u.id, r.kind + " 처리 완료");
        break;
      }
      case "schedule":
        manage();
        insist(!terminal, "종료된 공구예요.");
        run(
          "UPDATE pickup_schedules SET at=?,place=? WHERE buy=?",
          timestamp.min(clock()).parse(a.pickup),
          z.string().trim().min(1).max(100).parse(a.place),
          id,
        );
        broadcast(id, "수령 일정 또는 장소가 변경됐어요.");
        log(id, u.id, "수령 안내 변경");
        break;
      default:
        throw new Error("지원하지 않는 요청이에요.");
    }
    return { id };
  });
}
