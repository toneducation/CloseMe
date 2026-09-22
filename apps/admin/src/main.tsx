import {
  StrictMode,
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import { createRoot } from "react-dom/client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import "./style.css";
import { z } from "zod";
type Row = Record<string, unknown>;
type Session = { token: string; role: string; id: string };
type Action = { action: string; target: string; data?: Row; label: string };
const nav = [
  ["dashboard", "Overview"],
  ["users", "People"],
  ["profiles", "Profiles"],
  ["photos", "Reported photos"],
  ["reports", "Reports"],
  ["usernames", "Username inspector"],
  ["premium", "Premium usernames"],
  ["transfers", "Transfers"],
  ["matches", "Matches"],
  ["safety", "Safety cases"],
  ["staff", "Staff"],
  ["audit", "Audit log"],
  ["settings", "Emergency controls"],
];
function pretty(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.map(pretty).join(" · ");
  if (typeof v === "object")
    return Object.entries(v as Row)
      .map(([k, x]) => `${k.replaceAll("_", " ")}: ${pretty(x)}`)
      .join(" · ");
  return String(v);
}
function App() {
  const [client, setClient] = useState<SupabaseClient>();
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState("dashboard");
  const [rows, setRows] = useState<Row[]>([]);
  const [metrics, setMetrics] = useState<Row>({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<Row>();
  const [selected, setSelected] = useState<string>();
  const [action, setAction] = useState<Action>();
  const [reason, setReason] = useState("");
  const [recipientQuery, setRecipientQuery] = useState("");
  const [recipients, setRecipients] = useState<Row[]>([]);
  const [recipient, setRecipient] = useState<Row>();
  const [conversation, setConversation] = useState<Row[]>();
  const api = useCallback(
    async <T = Row[],>(path: string, body?: unknown): Promise<T> => {
      const r = await fetch(`/api/${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const value = await r.json();
      if (!r.ok)
        throw new Error(z.object({ error: z.string() }).parse(value).error);
      return value as T;
    },
    [session],
  );
  useEffect(() => {
    fetch("/api/config")
      .then(async (r) => {
        if (!r.ok)
          throw new Error(
            "Open this dashboard through your Cloudflare Access login.",
          );
        const c = z
          .object({ url: z.url(), key: z.string() })
          .parse(await r.json());
        setClient(
          createClient(c.url, c.key, {
            auth: {
              persistSession: false,
              autoRefreshToken: true,
              detectSessionInUrl: true,
            },
          }),
        );
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!client) return;
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, s) => {
      if (event === "TOKEN_REFRESHED" && s)
        setSession((prev) =>
          prev ? { ...prev, token: s.access_token } : prev,
        );
      if (event === "SIGNED_OUT") setSession(undefined);
    });
    return () => subscription.unsubscribe();
  }, [client]);
  const reload = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    setError("");
    try {
      if (section === "dashboard") {
        setMetrics(await api<Row>("metrics"));
        setRows(await api("list/audit"));
      } else if (section === "users")
        setRows(
          await api(`users?q=${encodeURIComponent(query)}&offset=${offset}`),
        );
      else if (section === "usernames") {
        if (query) {
          setDetail(
            await api<Row>(
              `username?q=${encodeURIComponent(query.replace(/^@/, ""))}`,
            ),
          );
        } else setDetail(undefined);
      } else setRows(await api(`list/${section}?offset=${offset}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [session, section, query, offset, api]);
  useEffect(() => {
    const t = setTimeout(() => void reload(), 250);
    return () => clearTimeout(t);
  }, [reload]);
  useEffect(() => {
    if (!action?.action.includes("USERNAME") || !recipientQuery) return;
    const t = setTimeout(() => {
      api(`users?q=${encodeURIComponent(recipientQuery)}`)
        .then(setRecipients)
        .catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [recipientQuery, action, api]);
  function chooseSection(id: string) {
    setSection(id);
    setRows([]);
    setQuery("");
    setOffset(0);
    setDetail(undefined);
    setSelected(undefined);
    setConversation(undefined);
  }
  async function inspectUser(id: string) {
    setBusy(true);
    try {
      setDetail(await api<Row>(`users/${id}`));
      setSelected(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function inspectHandle(name: string) {
    setBusy(true);
    try {
      setDetail(await api<Row>(`username?q=${name}`));
      setSelected(name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function propose(a: Action) {
    setAction(a);
    setReason("");
    setRecipient(undefined);
    setRecipientQuery("");
    setRecipients([]);
  }
  async function perform(e: FormEvent) {
    e.preventDefault();
    if (!action) return;
    setBusy(true);
    try {
      const data = {
        ...action.data,
        ...(recipient ? { recipient: recipient.id } : {}),
      };
      const result = await api("action", {
        action: action.action,
        target: action.target,
        reason,
        data,
      });
      if (action.action === "VIEW_REPORTED_CONVERSATION")
        setConversation(result);
      setAction(undefined);
      await reload();
      if (selected && section === "premium") await inspectHandle(selected);
      else if (selected && section === "users") await inspectUser(selected);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const canOwn = session?.role === "OWNER";
  const canHandles = canOwn || session?.role === "SUPER_ADMIN";
  const canModerate = session?.role !== "SUPPORT";
  const userActions = [
    "WARN_USER",
    ...(canModerate
      ? [
          "SUSPEND_USER",
          "UNSUSPEND_USER",
          "HIDE_PROFILE",
          "RESTORE_PROFILE",
          "DISABLE_MESSAGING",
          "ENABLE_MESSAGING",
          "REQUIRE_REVIEW",
        ]
      : []),
    ...(canHandles ? ["BAN_USER", "UNBAN_USER"] : []),
  ];
  const user = Array.isArray(detail?.user)
    ? (detail.user[0] as Row)
    : undefined;
  if (!session)
    return (
      <main className="login-shell">
        <div className="brand">
          CloseMe<span>PRIVATE ADMINISTRATION</span>
        </div>
        <div className="login-card">
          <div className="eyebrow">Trusted access only</div>
          <h1>
            A thoughtful space.
            <br />
            Carefully protected.
          </h1>
          <p>
            Manage meaningful connections with care. Staff access requires your
            password and authenticator.
          </p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {client && (
            <Login client={client} onLogin={setSession} onError={setError} />
          )}
        </div>
        <p className="muted">
          Cloudflare Access · Encrypted session · TOTP verification
        </p>
      </main>
    );
  return (
    <div className="layout">
      <aside>
        <div className="brand">
          CloseMe<span>CONTROL ROOM</span>
        </div>
        <nav aria-label="Administration">
          {nav
            .filter(([id]) => canOwn || !["staff", "settings"].includes(id!))
            .map(([id, label]) => (
              <button
                key={id}
                className={section === id ? "nav-active" : ""}
                onClick={() => chooseSection(id!)}
              >
                {label}
              </button>
            ))}
        </nav>
        <div className="staff-pill">
          <span className="dot" /> {session.role.replaceAll("_", " ")}
          <button onClick={() => void client?.auth.signOut()}>Sign out</button>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <span className="eyebrow">CloseMe / Private workspace</span>
            <h1>{nav.find((x) => x[0] === section)?.[1]}</h1>
          </div>
          <button onClick={() => void reload()} disabled={busy}>
            ↻ Refresh
          </button>
        </header>
        <p className="mobile-role">{session.role} · Protected session</p>
        {error && (
          <div role="alert" className="error">
            {error}
            <button onClick={() => setError("")} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        {busy && (
          <p role="status" className="muted">
            Updating…
          </p>
        )}
        {section === "dashboard" && (
          <>
            <section className="hero">
              <div>
                <span className="eyebrow">
                  Meaningful connections, thoughtfully managed
                </span>
                <h2>
                  People first.
                  <br />
                  Safety always.
                </h2>
                <p>
                  Your network at a glance. Every sensitive action leaves a
                  trace.
                </p>
              </div>
              <div className="hero-mark" aria-hidden="true">
                cm.
              </div>
            </section>
            <div className="metrics">
              {Object.entries(metrics).map(([key, value]) => (
                <article className="metric" key={key}>
                  <p>{key}</p>
                  <strong>{Number(value).toLocaleString()}</strong>
                  <span>Live from your platform</span>
                </article>
              ))}
            </div>
            <h2>Recent administration</h2>
            <Records rows={rows.slice(0, 8)} />
          </>
        )}
        {["users", "usernames"].includes(section) && (
          <label className="search">
            Search{" "}
            {section === "users"
              ? "username, name, city or ID"
              : "CloseMe username"}
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOffset(0);
              }}
              placeholder={section === "users" ? "Search people…" : "aziz"}
              maxLength={80}
            />
          </label>
        )}
        {section === "users" && !selected && (
          <div className="cards">
            {rows.map((r) => (
              <button
                className="person card"
                key={pretty(r.id)}
                onClick={() => void inspectUser(String(r.id))}
              >
                <div className="avatar">
                  {String(r.display_name ?? r.username ?? "?").slice(0, 1)}
                </div>
                <div>
                  <h3>@{pretty(r.username)}</h3>
                  <p>
                    {pretty(r.display_name)} · {pretty(r.age)}
                  </p>
                  <small>{pretty(r.city)}</small>
                </div>
                <Badge value={r.status} />
              </button>
            ))}
          </div>
        )}
        {section === "premium" && (
          <>
            <div className="section-intro">
              <div>
                <span className="eyebrow">The signature collection</span>
                <h2>36 characters. One identity.</h2>
                <p>Exclusive handles with permanent ownership history.</p>
              </div>
              <span className="pill">ADMIN CONTROLLED</span>
            </div>
            <div className="tabs">
              {["All", "AVAILABLE", "ASSIGNED", "RESERVED", "FROZEN"].map(
                (v) => (
                  <button
                    key={v}
                    className={filter === v ? "selected" : ""}
                    onClick={() => setFilter(v)}
                  >
                    {v.toLowerCase()}
                  </button>
                ),
              )}
            </div>
            <div className="handles">
              {rows
                .filter((r) => filter === "All" || r.status === filter)
                .map((r) => (
                  <button
                    key={pretty(r.canonical)}
                    className={`handle ${selected === r.canonical ? "selected" : ""}`}
                    onClick={() => void inspectHandle(String(r.canonical))}
                  >
                    <span className="eyebrow">PREMIUM HANDLE</span>
                    <strong>@{pretty(r.canonical)}</strong>
                    <Badge value={r.status} />
                  </button>
                ))}
            </div>
          </>
        )}
        {(section === "premium" || section === "usernames") && detail && (
          <section className="detail">
            <button
              className="close"
              onClick={() => {
                setDetail(undefined);
                setSelected(undefined);
              }}
            >
              Close
            </button>
            <span className="eyebrow">Identity inspector</span>
            <h2 className="handle-title">@{pretty(detail.name)}</h2>
            <Badge
              value={
                (detail.record as Row | undefined)?.status ?? detail.status
              }
            />
            <Fields row={(detail.record as Row) ?? { status: detail.status }} />
            {canHandles && (
              <div className="actions">
                {(String(detail.name).length === 1
                  ? [
                      "GIFT_USERNAME",
                      "TRANSFER_USERNAME",
                      "REASSIGN_USERNAME",
                      "RESERVE_USERNAME",
                      "FREEZE_USERNAME",
                      "RELEASE_USERNAME",
                    ]
                  : ["RESERVE_USERNAME", "FREEZE_USERNAME", "RELEASE_USERNAME"]
                ).map((a) => (
                  <button
                    key={a}
                    onClick={() =>
                      propose({
                        action: a,
                        target: String(detail.name),
                        label: `${a.replaceAll("_", " ")} @${detail.name}`,
                      })
                    }
                  >
                    {a.replace("_USERNAME", "").toLowerCase()}
                  </button>
                ))}
              </div>
            )}
            <h3>Ownership history</h3>
            <Records rows={(detail.history as Row[]) ?? []} />
          </section>
        )}
        {section === "users" && selected && detail && (
          <section className="detail">
            <button
              className="close"
              onClick={() => {
                setSelected(undefined);
                setDetail(undefined);
              }}
            >
              Back to people
            </button>
            <span className="eyebrow">Member profile</span>
            <h2>@{pretty(user?.username)}</h2>
            <Fields row={user ?? {}} />
            <Fields row={(detail.profile as Row) ?? {}} />
            <p>Interests: {pretty(detail.interests)}</p>
            <Fields row={(detail.counts as Row) ?? {}} />
            <div className="photo-strip">
              {((detail.photos as Row[]) ?? []).map((ph) => (
                <SecurePhoto
                  key={String(ph.id)}
                  id={String(ph.id)}
                  token={session.token}
                />
              ))}
            </div>
            <div className="actions">
              {userActions.map((a) => (
                <button
                  key={a}
                  onClick={() =>
                    propose({
                      action: a,
                      target: selected,
                      label: a.replaceAll("_", " "),
                    })
                  }
                >
                  {a.replaceAll("_", " ").toLowerCase()}
                </button>
              ))}
            </div>
            {(["history", "reports", "moderation"] as const).map((key) => (
              <section key={key}>
                <h3>{key}</h3>
                <Records rows={(detail[key] as Row[]) ?? []} />
              </section>
            ))}
          </section>
        )}
        {["reports", "safety", "photos"].includes(section) && (
          <div className="cards">
            {rows.map((r) => (
              <article className="card" key={String(r.id)}>
                <div className="row">
                  <h3>{pretty(r.category)}</h3>
                  <Badge value={r.priority} />
                </div>
                <p>{pretty(r.detail)}</p>
                <Fields row={r} />
                {r.photo_id ? (
                  <SecurePhoto id={String(r.photo_id)} token={session.token} />
                ) : null}
                <div className="actions">
                  <button
                    onClick={() => {
                      chooseSection("users");
                      void inspectUser(String(r.subject));
                    }}
                  >
                    View member
                  </button>
                  {canModerate && (
                    <>
                      <select
                        aria-label="Report status"
                        defaultValue=""
                        onChange={(e) => {
                          if (e.target.value)
                            propose({
                              action: "REVIEW_REPORT",
                              target: String(r.id),
                              label: `Set report ${e.target.value}`,
                              data: { state: e.target.value },
                            });
                        }}
                      >
                        <option value="">Change status…</option>
                        {[
                          "UNDER_REVIEW",
                          "ESCALATED",
                          "RESOLVED",
                          "DISMISSED",
                        ].map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                      <button
                        onClick={() =>
                          propose({
                            action: "REVIEW_REPORT",
                            target: String(r.id),
                            label: "Assign this case to me",
                            data: { assigned_to: session.id },
                          })
                        }
                      >
                        Assign to me
                      </button>
                      {r.conversation_id ? (
                        <button
                          onClick={() =>
                            propose({
                              action: "VIEW_REPORTED_CONVERSATION",
                              target: String(r.id),
                              label:
                                "Review reported conversation (access will be audited)",
                            })
                          }
                        >
                          Review conversation
                        </button>
                      ) : null}
                      {r.photo_id ? (
                        <>
                          <button
                            onClick={() =>
                              propose({
                                action: "HIDE_PHOTO",
                                target: String(r.photo_id),
                                label: "Hide reported photo",
                              })
                            }
                          >
                            Hide photo
                          </button>
                          <button
                            onClick={() =>
                              propose({
                                action: "RESTORE_PHOTO",
                                target: String(r.photo_id),
                                label: "Restore previously approved photo",
                              })
                            }
                          >
                            Restore photo
                          </button>
                        </>
                      ) : null}
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
        {conversation && (
          <section className="detail">
            <button onClick={() => setConversation(undefined)}>
              Close conversation review
            </button>
            <h3>Reported conversation · Access recorded</h3>
            <Records rows={conversation} />
          </section>
        )}
        {section === "staff" && canOwn && (
          <>
            <Invite api={api} done={reload} error={setError} />
            <div className="cards">
              {rows.map((r) => (
                <article className="card" key={String(r.id)}>
                  <h3>{pretty(r.email)}</h3>
                  <Fields row={r} />
                  {r.role !== "OWNER" && (
                    <div className="actions">
                      <select
                        aria-label="Staff role"
                        value={String(r.role)}
                        onChange={(e) =>
                          propose({
                            action: "CHANGE_STAFF_ROLE",
                            target: String(r.id),
                            label: `Change staff role to ${e.target.value}`,
                            data: { role: e.target.value },
                          })
                        }
                      >
                        {["SUPER_ADMIN", "MODERATOR", "SUPPORT"].map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                      <button
                        onClick={() =>
                          propose({
                            action: r.active ? "DISABLE_STAFF" : "ENABLE_STAFF",
                            target: String(r.id),
                            label: r.active
                              ? "Disable staff member"
                              : "Enable staff member",
                          })
                        }
                      >
                        {r.active ? "Disable" : "Enable"}
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </>
        )}
        {section === "settings" && canOwn && (
          <>
            <p>
              Emergency controls preserve existing data. Every change requires a
              reason and is audited.
            </p>
            <div className="cards">
              {rows.map((r) => (
                <article key={String(r.key)} className="card">
                  <h3>{pretty(r.key).replaceAll("_", " ")}</h3>
                  <p>
                    Current value: <strong>{pretty(r.value)}</strong>
                  </p>
                  {typeof r.value === "boolean" ? (
                    <button
                      className={r.value ? "danger" : "accent"}
                      onClick={() =>
                        propose({
                          action: "SECURITY_SETTING_CHANGE",
                          target: String(r.key),
                          label: `${r.value ? "Pause" : "Enable"} ${r.key}`,
                          data: { value: !r.value },
                        })
                      }
                    >
                      {r.value ? "Pause" : "Enable"}
                    </button>
                  ) : (
                    <select
                      aria-label="Daily request limit"
                      value={Number(r.value)}
                      onChange={(e) =>
                        propose({
                          action: "SECURITY_SETTING_CHANGE",
                          target: String(r.key),
                          label: "Change daily message request limit",
                          data: { value: Number(e.target.value) },
                        })
                      }
                    >
                      {Array.from({ length: 20 }, (_, i) => (
                        <option key={i} value={i + 1}>
                          {i + 1}
                        </option>
                      ))}
                    </select>
                  )}
                </article>
              ))}
            </div>
          </>
        )}
        {["profiles", "transfers", "matches", "audit"].includes(section) && (
          <Records
            rows={rows}
            onUser={
              section === "profiles"
                ? (r) => {
                    chooseSection("users");
                    void inspectUser(String(r.user_id));
                  }
                : undefined
            }
          />
        )}
        {!busy &&
          rows.length === 0 &&
          !["dashboard", "usernames"].includes(section) && (
            <div className="empty">
              <h3>Nothing here yet</h3>
              <p>Live records will appear as people use CloseMe.</p>
            </div>
          )}
        {!["dashboard", "premium", "usernames", "settings"].includes(
          section,
        ) && (
          <div className="pager">
            <button
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              Previous
            </button>
            <span>Page {offset / 50 + 1}</span>
            <button
              disabled={rows.length < 50}
              onClick={() => setOffset(offset + 50)}
            >
              Next
            </button>
          </div>
        )}
      </main>
      {action && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            className="modal"
          >
            <button
              className="close"
              onClick={() => setAction(undefined)}
              disabled={busy}
            >
              Cancel
            </button>
            <span className="eyebrow">Review before confirming</span>
            <h2 id="confirm-title">{action.label}</h2>
            <p className="muted">Target: {action.target}</p>
            <form onSubmit={perform}>
              {[
                "GIFT_USERNAME",
                "TRANSFER_USERNAME",
                "REASSIGN_USERNAME",
              ].includes(action.action) && (
                <>
                  <label>
                    Find recipient
                    <input
                      autoFocus
                      value={recipientQuery}
                      onChange={(e) => {
                        setRecipientQuery(e.target.value);
                        setRecipient(undefined);
                      }}
                      placeholder="@username, name or ID"
                    />
                  </label>
                  <div className="recipient-list">
                    {recipients.slice(0, 6).map((r) => (
                      <button
                        type="button"
                        key={String(r.id)}
                        className={recipient?.id === r.id ? "selected" : ""}
                        onClick={() => setRecipient(r)}
                      >
                        <strong>@{pretty(r.username)}</strong> ·{" "}
                        {pretty(r.display_name)}
                        <small>{pretty(r.id)}</small>
                      </button>
                    ))}
                  </div>
                  {recipient && (
                    <p>
                      Recipient: <strong>@{pretty(recipient.username)}</strong>
                    </p>
                  )}
                </>
              )}
              <label>
                Reason (required)
                <textarea
                  autoFocus={!action.action.includes("USERNAME")}
                  required
                  minLength={5}
                  maxLength={1000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <p>This action is recorded in the permanent audit log.</p>
              <button
                className="accent full"
                disabled={
                  busy ||
                  reason.trim().length < 5 ||
                  ([
                    "GIFT_USERNAME",
                    "TRANSFER_USERNAME",
                    "REASSIGN_USERNAME",
                  ].includes(action.action) &&
                    !recipient)
                }
              >
                {busy
                  ? "Working…"
                  : `Confirm ${action.action.replaceAll("_", " ").toLowerCase()}`}
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
function Fields({ row }: { row: Row }) {
  return (
    <dl>
      {Object.entries(row).map(([k, v]) => (
        <div key={k}>
          <dt>{k.replaceAll("_", " ")}</dt>
          <dd>{pretty(v)}</dd>
        </div>
      ))}
    </dl>
  );
}
function Badge({ value }: { value: unknown }) {
  return (
    <span className={`badge ${String(value).toLowerCase()}`}>
      {pretty(value)}
    </span>
  );
}
function Records({ rows, onUser }: { rows: Row[]; onUser?: (r: Row) => void }) {
  return (
    <div className="records">
      {rows.map((r, i) => (
        <article className="card" key={String(r.id ?? i)}>
          <Fields row={r} />
          {onUser && <button onClick={() => onUser(r)}>View member</button>}
        </article>
      ))}
      {rows.length === 0 && <p className="muted">No records.</p>}
    </div>
  );
}
function SecurePhoto({ id, token }: { id: string; token: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let url = "",
      cancelled = false;
    fetch(`/api/photo/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) throw new Error("PHOTO");
        return r.blob();
      })
      .then((blob) => {
        if (!cancelled) {
          url = URL.createObjectURL(blob);
          setSrc(url);
        }
      })
      .catch(() => setSrc(""));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, token]);
  return src ? (
    <img className="profile-photo" src={src} alt="Member profile photograph" />
  ) : (
    <span className="muted">Photo unavailable</span>
  );
}
function Invite({
  api,
  done,
  error,
}: {
  api: (p: string, b?: unknown) => Promise<unknown>;
  done: () => Promise<void>;
  error: (s: string) => void;
}) {
  const [email, setEmail] = useState(""),
    [role, setRole] = useState("SUPPORT"),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <form
      className="card invite"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!window.confirm(`Invite ${email} as ${role}?`)) return;
        setBusy(true);
        try {
          await api("invite", { email, role, reason });
          setEmail("");
          setReason("");
          await done();
        } catch (e) {
          error((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Invite a trusted colleague</h3>
      <label>
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label>
        Role
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          {["SUPPORT", "MODERATOR", "SUPER_ADMIN"].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </label>
      <label>
        Reason
        <input
          required
          minLength={5}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <button disabled={busy} className="accent">
        Send invitation
      </button>
    </form>
  );
}
function Login({
  client,
  onLogin,
  onError,
}: {
  client: SupabaseClient;
  onLogin: (s: Session) => void;
  onError: (s: string) => void;
}) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [factor, setFactor] = useState(""),
    [secret, setSecret] = useState(""),
    [qr, setQr] = useState(""),
    [busy, setBusy] = useState(false),
    [invited, setInvited] = useState(false);
  async function prepare() {
    const { data, error } = await client.auth.mfa.listFactors();
    if (error) throw error;
    const f = data.totp.find((x) => x.status === "verified");
    if (f) {
      setFactor(f.id);
      return;
    }
    for (const old of data.all)
      if (old.status === "unverified")
        await client.auth.mfa.unenroll({ factorId: old.id });
    const enrolled = await client.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "CloseMe authenticator",
    });
    if (enrolled.error) throw enrolled.error;
    setFactor(enrolled.data.id);
    setSecret(enrolled.data.totp.secret);
    setQr(enrolled.data.totp.qr_code);
  }
  useEffect(() => {
    client.auth.getSession().then(({ data }) => {
      if (data.session) setInvited(true);
    });
  }, [client]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    onError("");
    try {
      if (!factor) {
        if (invited) {
          const { error } = await client.auth.updateUser({ password });
          if (error) throw error;
        } else {
          const { error } = await client.auth.signInWithPassword({
            email,
            password,
          });
          if (error) throw error;
        }
        await prepare();
      } else {
        const { error } = await client.auth.mfa.challengeAndVerify({
          factorId: factor,
          code,
        });
        if (error) throw error;
        const { data } = await client.auth.getSession();
        if (!data.session) throw new Error("Sign in again.");
        const r = await fetch("/api/me", {
          headers: { Authorization: `Bearer ${data.session.access_token}` },
        });
        const raw = await r.json();
        if (!r.ok)
          throw new Error(z.object({ error: z.string() }).parse(raw).error);
        const me = z.object({ id: z.uuid(), role: z.string() }).parse(raw);
        setSecret("");
        setQr("");
        onLogin({ ...me, token: data.session.access_token });
      }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      {!factor ? (
        <>
          {!invited && (
            <label>
              Staff email
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          )}
          <label>
            {invited ? "Create your staff password" : "Password"}
            <input
              type="password"
              required
              minLength={12}
              autoComplete={invited ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </>
      ) : (
        <>
          {secret && (
            <div className="enrollment">
              <h3>Set up your authenticator</h3>
              <p>
                On this phone, copy this setup key into your authenticator app,
                or scan the QR using another device.
              </p>
              {qr && (
                <img
                  className="qr"
                  src={
                    qr.startsWith("data:")
                      ? qr
                      : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`
                  }
                  alt="Authenticator enrollment QR"
                />
              )}
              <code>{secret}</code>
              <p>Keep the setup key private.</p>
            </div>
          )}
          <label>
            Six-digit authenticator code
            <input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
        </>
      )}
      <button className="accent full" disabled={busy}>
        {busy
          ? "Verifying…"
          : factor
            ? "Verify and enter"
            : "Continue securely"}
      </button>
    </form>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
