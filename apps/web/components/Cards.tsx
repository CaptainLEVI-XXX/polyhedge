'use client';

import type { QuotedView } from '@/lib/view-model';

/**
 * The choice between whole baskets.
 *
 * Each card is a complete, executable basket for the same exposure — not a
 * variant of one answer. They are honestly comparable because every stop solves
 * the SAME target shape, so each one's coverage is already measured against the
 * full loss described, and they were all priced against one pinned snapshot so
 * the prices are the same instant.
 *
 * Three numbers, chosen because they are what differs: what it costs, what it
 * covers, and what it leaves uncovered. The third is the one a product like
 * this is tempted to bury, so it sits on the face of the card in the colour of
 * a loss. A card showing only cost and coverage would be an advertisement.
 */
export function Cards({
  view,
  onOpen,
  onRefine,
}: {
  view: QuotedView;
  onOpen: (index: number) => void;
  onRefine: (text: string) => void;
}) {
  return (
    <>
      <div className="section">
        <h3>
          Understood as
          <span className="aside">click any of these to correct it</span>
        </h3>
        <div className="chips">
          <Chip k="Subject" v={view.parsed.subject} onEdit={onRefine} />
          <Chip k="Covers" v={view.parsed.exposureLabel} onEdit={onRefine} />
          <Chip k="Settles" v={view.parsed.settlesLabel.slice(0, 10)} onEdit={onRefine} />
          {/* Absent rather than zero: an unnamed budget is not a budget of nothing. */}
          {view.parsed.budgetLabel !== null && (
            <Chip k="Budget" v={view.parsed.budgetLabel} onEdit={onRefine} />
          )}
        </div>
      </div>

      <div className="section">
        <h3>
          {view.options.length === 1 ? 'One way to cover it' : `${view.options.length} ways to cover it`}
          <span className="aside">priced together, on one snapshot of the book</span>
        </h3>

        <div className="cards">
          {view.options.map((option, i) => (
            <button key={option.id} className="card" onClick={() => onOpen(i)}>
              <div className="card-name">{option.name}</div>
              <div className="card-cost">{option.costLabel}</div>
              <div className="card-reason">{firstSentence(option.reason)}</div>

              <div className="card-line">
                <span className="k">Pays you</span>
                <span className="v covered">{option.paysLabel}</span>
              </div>
              <div className="card-line">
                <span className="k">Scenario coverage</span>
                <span className="v">{option.coverageLabel}</span>
              </div>

              {option.netLossLabel !== undefined && (
                <div className="card-line">
                  <span className="k">Worst loss incl. premium</span>
                  <span className="v short">{option.netLossLabel}</span>
                </div>
              )}
              <div className="card-line">
                {/* Never behind a click. */}
                <span className="k">Not covered</span>
                <span className="v short">{option.shortfallLabel}</span>
              </div>

              <div className="meter" aria-hidden>
                <span style={{ width: `${Math.min(100, option.coverageRatio * 100)}%` }} />
              </div>

              <div className="card-go">
                Open this basket
                <span aria-hidden>→</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/**
 * One understood fact, correctable.
 *
 * Editing loads the original words back into the composer rather than opening a
 * field. The sentence is the source of truth — patching a parsed value while
 * leaving the sentence saying something else would give two answers to "what
 * did I ask for".
 */
function Chip({ k, v, onEdit }: { k: string; v: string; onEdit: (text: string) => void }) {
  return (
    <button className="chip edit" onClick={() => onEdit(`${v} — `)} title={`Change: ${v}`}>
      <span className="k">{k}</span> <b>{v}</b>
    </button>
  );
}

/** Cards carry the claim; the reasoning belongs inside. */
function firstSentence(reason: string): string {
  const end = reason.indexOf('. ');
  return end === -1 ? reason : reason.slice(0, end + 1);
}
