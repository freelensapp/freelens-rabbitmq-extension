import { Renderer } from "@freelensapp/extensions";
import { useMemo, useState } from "react";
import { RABBITMQ_PEEK_DEFAULT_COUNT, RABBITMQ_PEEK_MAX_COUNT } from "../../common/constants";
import { planReplay } from "../../common/dead-letter";
import { parseIpcError } from "../../common/errors";
import { ErrorPanel, KeyValueList, SearchBox } from "../components/page-shell";
import {
  DEATH_HEADER_KEYS,
  DEATH_REASON_TEXT,
  type DeathInfo,
  deathReason,
  matchesMessage,
  matchesReason,
  parseDeath,
  summarizeDeaths,
} from "../dead-letter";
import { formatBytes, formatTimestamp, prettyJson } from "../format";

import type { ReplayDestination } from "../../common/dead-letter";
import type {
  MessagesPeekDto,
  PeekedMessageDto,
  RabbitmqIpcErrorShape,
  ReplayMessageInput,
  ReplayResultDto,
} from "../../common/ipc";

function Payload({ message }: { message: PeekedMessageDto }) {
  if (message.contentKind === "binary") {
    return (
      <>
        <p className="RmqMuted">Binary payload shown as base64.</p>
        <pre>{message.payload}</pre>
      </>
    );
  }
  return <pre>{message.contentKind === "json" ? prettyJson(message.payload) : message.payload}</pre>;
}

function routingKeysText(keys: string[]): string {
  return keys.length > 0 ? keys.join(", ") : "(empty routing key)";
}

/** Decoded `x-death`: why the message was dead-lettered, where, how often, and where it came from. */
function DeathHistory({ death }: { death: DeathInfo }) {
  const reason = deathReason(death);
  return (
    <>
      <h3>Dead-letter history</h3>
      <p className="RmqMuted">{DEATH_REASON_TEXT[reason] ?? `Dead-lettered with reason "${reason}".`}</p>
      <KeyValueList
        entries={[
          ...(death.original
            ? ([
                [
                  "Originally published to",
                  <code>
                    {death.original.exchange || "(default exchange)"} · {routingKeysText(death.original.routingKeys)}
                  </code>,
                ],
              ] as [string, JSX.Element][])
            : []),
          ...death.history.map(
            (e) =>
              [
                `${e.reason} in ${e.queue}`,
                <span>
                  {e.count > 1 ? `${e.count} times · ` : ""}
                  <code>
                    {e.exchange || "(default exchange)"} · {routingKeysText(e.routingKeys)}
                  </code>
                  {e.time !== undefined ? ` · ${formatTimestamp(e.time)}` : ""}
                </span>,
              ] as [string, JSX.Element],
          ),
        ]}
      />
    </>
  );
}

function MessageCard({
  message,
  selection,
  replayedTo,
}: {
  message: PeekedMessageDto;
  /** Present when the message can be replayed: a dead letter with a complete payload. */
  selection?: { selected: boolean; onChange: (selected: boolean) => void };
  /** Set once this message was replayed successfully in this batch: where the copy went. */
  replayedTo?: string;
}) {
  const [open, setOpen] = useState(message.index === 0);
  const props = message.properties;
  const death = useMemo(() => parseDeath(message), [message]);
  // `properties` is `[]` when the broker sent none; the decoded history replaces the x-death headers.
  const rawHeaders = (props.headers as Record<string, unknown> | undefined) ?? {};
  const headers = death
    ? Object.fromEntries(Object.entries(rawHeaders).filter(([k]) => !DEATH_HEADER_KEYS.has(k)))
    : rawHeaders;
  const propEntries = Object.entries(props).filter(([k]) => k !== "headers");
  return (
    <article className="RmqMessage">
      <div className="RmqMessageHead" onClick={() => setOpen((o) => !o)} role="button" tabIndex={0}>
        {selection ? (
          // Selecting must not expand or collapse the card.
          <span className="RmqMessageSelect" onClick={(e) => e.stopPropagation()}>
            <Renderer.Component.Checkbox value={selection.selected} onChange={selection.onChange} />
          </span>
        ) : null}
        <Renderer.Component.Icon material={open ? "expand_more" : "chevron_right"} small />
        <span className="RmqMessageIdx">#{message.index + 1}</span>
        <span className="RmqMono">{message.routingKey || "(no routing key)"}</span>
        <span className="RmqMessageMeta">via {message.exchange || "(default exchange)"}</span>
        <span className="RmqMessageSpacer" />
        {death ? (
          <>
            <Renderer.Component.Badge small label={deathReason(death)} className="warning" />
            <span className="RmqMessageMeta">
              from {death.lastQueue ?? "?"}
              {death.total > 1 ? ` · ${death.total}×` : ""}
            </span>
          </>
        ) : null}
        {replayedTo ? (
          <span className="RmqMessageMeta" title={`A copy was replayed to ${replayedTo}`}>
            <Renderer.Component.Badge small label="replayed" className="success" />
          </span>
        ) : null}
        <Renderer.Component.Badge small label={message.contentKind.toUpperCase()} />
        {message.redelivered ? <Renderer.Component.Badge small label="redelivered" /> : null}
        {message.truncated ? <Renderer.Component.Badge small label="truncated" className="warning" /> : null}
        <span className="RmqMessageMeta">{formatBytes(message.payloadBytes)}</span>
      </div>
      {open ? (
        <div className="RmqMessageBody">
          <Payload message={message} />
          {death ? <DeathHistory death={death} /> : null}
          {propEntries.length > 0 ? (
            <>
              <h3>Properties</h3>
              <KeyValueList
                entries={propEntries.map(([k, v]) => [k, <code>{typeof v === "string" ? v : JSON.stringify(v)}</code>])}
              />
            </>
          ) : null}
          {Object.keys(headers).length > 0 ? (
            <>
              <h3>Headers</h3>
              <KeyValueList
                entries={Object.entries(headers).map(([k, v]) => [
                  k,
                  <code>{typeof v === "string" ? v : JSON.stringify(v)}</code>,
                ])}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/**
 * Read-only Message Inspector: fetches up to N messages with `ack_requeue_true`, so nothing is
 * consumed. The broker still flags them `redelivered` — this is inherent to the Management API.
 */
const REPLAY_DESTINATIONS: Renderer.Component.SelectOption<ReplayDestination>[] = [
  { value: "failed-queue", label: "Back to the queue it failed in" },
  { value: "original-exchange", label: "Original exchange and routing key" },
];

function toReplayInput(m: PeekedMessageDto): ReplayMessageInput {
  return {
    index: m.index,
    payload: m.payload,
    payloadEncoding: m.payloadEncoding,
    truncated: m.truncated,
    properties: m.properties,
  };
}

function destinationLabel(exchange: string, routingKey: string): string {
  return exchange ? `${exchange} · ${routingKey}` : `queue ${routingKey} (default exchange)`;
}

export function MessageInspector({
  peek,
  queueMessages,
  queueName,
  writeMode,
  replay,
}: {
  peek: (count: number) => Promise<MessagesPeekDto>;
  queueMessages: number;
  /** The queue being inspected (named in the replay confirmation). */
  queueName: string;
  /** Replay is a write: it is offered only while Write Mode is armed for this target. */
  writeMode: boolean;
  replay?: (destination: ReplayDestination, messages: ReplayMessageInput[]) => Promise<ReplayResultDto>;
}) {
  const [count, setCount] = useState(String(RABBITMQ_PEEK_DEFAULT_COUNT));
  const [result, setResult] = useState<MessagesPeekDto>();
  const [error, setError] = useState<RabbitmqIpcErrorShape>();
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [destination, setDestination] = useState<ReplayDestination>("failed-queue");
  const [replayResult, setReplayResult] = useState<ReplayResultDto>();
  // Messages of this batch already replayed successfully (index -> where the copy went), so a second
  // "select all" does not publish duplicates by accident.
  const [replayed, setReplayed] = useState<ReadonlyMap<number, string>>(new Map());
  const messages = result?.messages ?? [];
  const summary = useMemo(() => summarizeDeaths(messages), [messages]);
  const reasonOptions: Renderer.Component.SelectOption<string>[] = [
    { value: "", label: "All messages" },
    ...summary.byReason.map((r) => ({ value: r.reason, label: `${r.reason} (${r.messages})` })),
    ...(summary.deadLettered < summary.total
      ? [{ value: "none", label: `Not dead-lettered (${summary.total - summary.deadLettered})` }]
      : []),
  ];
  // A new peek may not contain the reason picked for the previous batch: fall back to all messages.
  const activeReason = reasonOptions.some((o) => o.value === reason) ? reason : "";
  const shown = useMemo(
    () => messages.filter((m) => matchesReason(m, activeReason) && matchesMessage(m, query)),
    [messages, activeReason, query],
  );

  const run = async () => {
    const n = Math.max(1, Math.min(RABBITMQ_PEEK_MAX_COUNT, Number.parseInt(count, 10) || RABBITMQ_PEEK_DEFAULT_COUNT));
    setBusy(true);
    setError(undefined);
    try {
      setResult(await peek(n));
      // Indices refer to the batch they were picked from.
      setSelected(new Set());
      setReplayResult(undefined);
      setReplayed(new Map());
    } catch (err) {
      setError(parseIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  const isReplayable = (m: PeekedMessageDto) => Boolean(replay) && !m.truncated && parseDeath(m) !== undefined;
  const replayableShown = shown.filter(isReplayable);
  // Only what the user can see is replayed: selections hidden by the search or reason filter are left out.
  const chosen = replayableShown.filter((m) => selected.has(m.index));
  const hiddenSelected = messages.filter((m) => selected.has(m.index) && !shown.includes(m)).length;
  const toggle = (index: number, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  const tooLarge = shown.filter((m) => m.truncated && parseDeath(m) !== undefined).length;
  // "Select all" skips messages already replayed from this batch; they stay selectable one by one.
  const selectable = replayableShown.filter((m) => !replayed.has(m.index));
  const allShownSelected = selectable.length > 0 && selectable.every((m) => selected.has(m.index));
  const selectAllShown = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of selectable) {
        if (on) next.add(m.index);
        else next.delete(m.index);
      }
      return next;
    });

  const confirmReplay = () => {
    if (!replay || chosen.length === 0) return;
    // Preview with the same planner Main uses; Main recomputes and is the authority.
    const groups = new Map<string, number>();
    let skipped = 0;
    for (const m of chosen) {
      const plan = planReplay(m, destination);
      if ("error" in plan) skipped += 1;
      else {
        const label = destinationLabel(plan.exchange, plan.routingKey);
        groups.set(label, (groups.get(label) ?? 0) + 1);
      }
    }
    Renderer.Component.ConfirmDialog.open({
      labelOk: `Replay ${chosen.length}`,
      message: (
        <div className="RmqConfirm">
          <p>
            <strong>
              Replay {chosen.length} message{chosen.length === 1 ? "" : "s"} from {queueName}
            </strong>
          </p>
          <ul>
            {[...groups].map(([label, n]) => (
              <li key={label}>
                {n} → {label}
              </li>
            ))}
            {skipped > 0 ? <li>{skipped} cannot go to this destination and will be skipped</li> : null}
          </ul>
          <p>
            Copies are published; the originals stay in {queueName} (purge it afterwards if you want). Replaying the
            same messages again publishes duplicates. Dead-letter and delivery-count headers are removed; payload and
            other properties are unchanged.
          </p>
          {destination === "failed-queue" ? (
            <p>CC/BCC headers are removed, so each copy reaches only the queue it failed in.</p>
          ) : null}
          {destination === "original-exchange" ? (
            <p>
              <strong>Every queue bound to the original exchange with these routing keys receives a copy</strong>,
              including consumers that already processed the message. CC/BCC headers are kept.
            </p>
          ) : null}
        </div>
      ),
      ok: async () => {
        setBusy(true);
        try {
          const res = await replay(destination, chosen.map(toReplayInput));
          setReplayResult(res);
          setSelected(new Set());
          setReplayed((prev) => {
            const next = new Map(prev);
            for (const r of res.results) {
              if (r.outcome === "routed" && r.routingKey !== undefined) {
                next.set(r.index, destinationLabel(r.exchange ?? "", r.routingKey));
              }
            }
            return next;
          });
          const text = `Replayed ${res.routed} of ${chosen.length}`;
          if (res.routed === chosen.length) Renderer.Component.Notifications.ok(text);
          else Renderer.Component.Notifications.error(`${text}: see the result above the messages`);
        } catch (err) {
          Renderer.Component.Notifications.error(`Replay failed: ${parseIpcError(err).message}`);
        } finally {
          setBusy(false);
        }
      },
    });
  };

  return (
    <div className="RmqMessages">
      <div className="RmqNotice">
        <Renderer.Component.Icon material="verified_user" small />
        <p>
          Safe peek: messages are fetched with <code>ackmode=ack_requeue_true</code> and immediately re-queued. Nothing
          is consumed or lost. Peeked messages will carry the <em>redelivered</em> flag afterwards.
        </p>
      </div>
      <div className="RmqDrawerToolbar">
        <span className="RmqMuted">Messages to peek (1–{RABBITMQ_PEEK_MAX_COUNT})</span>
        <Renderer.Component.Input
          theme="round-black"
          value={count}
          onChange={setCount}
          type="number"
          min={1}
          max={RABBITMQ_PEEK_MAX_COUNT}
          style={{ width: 80 }}
        />
        <Renderer.Component.Button
          primary
          label={busy ? "Peeking…" : "Peek"}
          disabled={busy || queueMessages === 0}
          onClick={() => void run()}
        />
        {queueMessages === 0 ? <span className="RmqMuted">Queue is empty</span> : null}
        {result ? <span className="RmqMuted">{result.messages.length} message(s) fetched</span> : null}
      </div>
      {error ? <ErrorPanel error={error} onRetry={() => void run()} /> : null}
      {summary.deadLettered > 0 ? (
        <div className="RmqNotice warning">
          <Renderer.Component.Icon material="report" small />
          <p>
            <strong>
              {summary.deadLettered} of {summary.total} dead-lettered.
            </strong>{" "}
            Why: {summary.byReason.map((r) => `${r.reason} ${r.messages}`).join(", ")}. Died in:{" "}
            {summary.byQueue.map((q) => `${q.queue} (${q.messages})`).join(", ")}.
          </p>
        </div>
      ) : null}
      {messages.length > 0 ? (
        <div className="RmqDrawerToolbar">
          <SearchBox value={query} onChange={setQuery} placeholder="Search payload, routing key, headers…" />
          {summary.deadLettered > 0 ? (
            <Renderer.Component.Select
              options={reasonOptions}
              value={activeReason}
              onChange={(o: Renderer.Component.SelectOption<string> | null) => setReason(o?.value ?? "")}
              themeName="lens"
              menuPosition="fixed"
            />
          ) : null}
          <span className="RmqMuted">
            {shown.length} of {messages.length} shown
          </span>
        </div>
      ) : null}
      {replayResult ? (
        <div className={`RmqNotice ${replayResult.routed === replayResult.results.length ? "" : "warning"}`.trim()}>
          <Renderer.Component.Icon material="replay" small />
          <div>
            <p>
              <strong>
                Replayed {replayResult.routed} of {replayResult.results.length}.
              </strong>{" "}
              {[
                replayResult.unroutable > 0 ? `${replayResult.unroutable} unroutable` : "",
                replayResult.skipped > 0 ? `${replayResult.skipped} skipped` : "",
                replayResult.failed > 0 ? `${replayResult.failed} failed` : "",
              ]
                .filter(Boolean)
                .join(", ")}
            </p>
            {replayResult.results
              .filter((r) => r.outcome !== "routed")
              .map((r) => (
                <p key={r.index} className="RmqMuted">
                  #{r.index + 1}: {r.outcome}
                  {r.message ? ` - ${r.message}` : ""}
                </p>
              ))}
          </div>
        </div>
      ) : null}
      {replay && (replayableShown.length > 0 || tooLarge > 0) ? (
        <div className="RmqDrawerToolbar">
          <Renderer.Component.Checkbox
            label={`Select all dead-lettered shown (${selectable.length})`}
            value={allShownSelected}
            onChange={selectAllShown}
          />
          <Renderer.Component.Select
            options={REPLAY_DESTINATIONS}
            value={destination}
            onChange={(o: Renderer.Component.SelectOption<ReplayDestination> | null) =>
              setDestination(o?.value ?? "failed-queue")
            }
            themeName="lens"
            menuPosition="fixed"
          />
          <Renderer.Component.Button
            primary
            label={busy ? "Replaying…" : `Replay ${chosen.length}…`}
            disabled={!writeMode || busy || chosen.length === 0}
            tooltip={writeMode ? undefined : "Enable Write Mode to replay"}
            onClick={confirmReplay}
          />
          {!writeMode ? (
            <span className="RmqMuted">
              To replay, close this panel and switch Read-only to Write Mode in the page header.
            </span>
          ) : null}
          {tooLarge > 0 ? (
            <span className="RmqMuted">
              {tooLarge} dead letter{tooLarge === 1 ? " is" : "s are"} larger than the 64 KiB peek limit and cannot be
              replayed.
            </span>
          ) : null}
          {hiddenSelected > 0 ? (
            <span className="RmqMuted">
              {hiddenSelected} selected message{hiddenSelected === 1 ? " is" : "s are"} hidden by the filter and will
              not be replayed.
            </span>
          ) : null}
        </div>
      ) : null}
      {shown.map((m) => (
        <MessageCard
          key={m.index}
          message={m}
          selection={
            isReplayable(m)
              ? { selected: selected.has(m.index), onChange: (on: boolean) => toggle(m.index, on) }
              : undefined
          }
          replayedTo={replayed.get(m.index)}
        />
      ))}
      {messages.length > 0 && shown.length === 0 ? <p className="RmqMuted">No peeked message matches.</p> : null}
    </div>
  );
}
