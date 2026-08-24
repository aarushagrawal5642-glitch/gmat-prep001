import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import "katex/dist/katex.min.css";
import Latex from "react-latex-next";
import {
  Clock,
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  XCircle,
  AlertCircle,
  BookOpen,
  BarChart3,
  ArrowLeft,
  Flag,
  Eye,
  ZoomIn,
  X,
  Lock,
  ListChecks,
  Play,
  Coffee,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { apiRequest } from "@/src/lib/api";

// ─────────────────────────────────────────────────────────────────────────
// TYPES — same content model as the sectional tests (same underlying
// MockQuestions/MockPassages sheets), so the rendering engine below is
// ported straight from the sectional test component rather than
// reinvented. That's what fixes passages, blanks, and LaTeX going missing.
// ─────────────────────────────────────────────────────────────────────────

type GmatSection = "Quant" | "Verbal" | "DataInsights";

type QuestionType =
  | "standard_mcq"
  | "table_analysis"
  | "graphics_interpretation"
  | "two_part_analysis"
  | "multi_source_reasoning";

type StimulusKind = "text" | "table" | "chart" | "tabs";

interface StimulusTable {
  columns: string[];
  rows: (string | number)[][];
}

interface StimulusTab {
  label: string;
  content: string | StimulusTable;
}

interface Stimulus {
  id: string;
  title: string;
  kind: StimulusKind;
  text?: string;
  table?: StimulusTable;
  chartImageUrl?: string;
  tabs?: StimulusTab[];
}

interface StatementRow {
  id: string;
  text: string;
  correctAnswer: "Yes" | "No";
}

interface DropdownBlank {
  id: string;
  choices: string[];
  correctChoice: string;
}

interface SectionalQuestion {
  id: string;
  section: GmatSection;
  questionType: QuestionType;
  questionText: string;
  difficulty: "Easy" | "Medium" | "Hard";
  passageId?: string; // -> Stimulus.id

  options?: string[];
  correctAnswer?: string;

  statements?: StatementRow[];
  blanks?: DropdownBlank[];

  twoPartOptions?: string[];
  correctPart1?: string;
  correctPart2?: string;

  explanation: string;
}

interface SectionalTest {
  id: string;
  name: string;
  section: GmatSection;
  durationMinutes: number;
  questions: SectionalQuestion[];
  passages?: Stimulus[];
}

interface FullMockTest {
  id: string;
  name: string;
  description?: string;
  quantSection: SectionalTest;
  verbalSection: SectionalTest;
  dataInsightsSection: SectionalTest;
}

type QuestionAnswer =
  | { kind: "single"; value: string }
  | { kind: "statements"; values: Record<string, "Yes" | "No"> }
  | { kind: "blanks"; values: Record<string, string> }
  | { kind: "twoPart"; part1?: string; part2?: string };

type AnswersMap = Record<string, QuestionAnswer>;

interface SectionResult {
  section: GmatSection;
  scaledScore: number; // 60-90
  correct: number;
  wrong: number;
  skipped: number;
  timeSpent: number;
  studentAnswers: AnswersMap;
}

interface FullMockResult {
  mockId: string;
  totalScaledScore: number; // 205 - 805
  sectionOrder: GmatSection[];
  sectionResults: Record<GmatSection, SectionResult>;
  totalTimeSpent: number;
  completedAt: string;
}

// ── Shapes that actually come back from the server ────────────────────────
// GET /api/mock-tests returns lightweight summaries (id/section per question
// only). A single MockTest row holds questions from ALL THREE sections
// mixed together (grouped by q.section) rather than three separately
// authored sectional tests.
interface MockQuestionRef {
  id: string;
  section: GmatSection;
}

interface MockTestSummary {
  id: string;
  name: string;
  description?: string;
  totalDurationMinutes?: number;
  sectionDurationMinutes?: number;
  targetExam?: string;
  publishedDate?: string;
  studentsAttempted?: number;
  questions: MockQuestionRef[];
}

// GET /api/mock-test/:id returns raw MockQuestion / MockPassage rows.
// Unlike SectionalQuestions/SectionalPassages, the server does NOT unpack
// these for the Mock endpoints (fetchSheetData only special-cases
// range === "SectionalQuestions" / "SectionalPassages"), so:
//  - statements/blanks/twoPartOptions/correctPart1/correctPart2 arrive
//    nested under `typeData` instead of flattened onto the question, and
//  - table/tabs passage content arrives nested under `data` instead of
//    flattened onto `table`/`tabs`.
// Both have to be unwrapped on the client, which the old component never
// did — that's why passages and blanks were invisible.
interface RawMockQuestion extends Omit<SectionalQuestion, "statements" | "blanks" | "twoPartOptions" | "correctPart1" | "correctPart2"> {
  typeData?: {
    statements?: StatementRow[];
    blanks?: DropdownBlank[];
    twoPartOptions?: string[];
    correctPart1?: string;
    correctPart2?: string;
  };
}

interface RawMockPassage {
  id: string;
  title: string;
  kind: StimulusKind;
  text?: string;
  data?: StimulusTable | StimulusTab[];
  table?: StimulusTable;
  tabs?: StimulusTab[];
  chartImageUrl?: string;
}

interface RawMockTestDetail {
  id: string;
  name: string;
  description?: string;
  totalDurationMinutes?: number;
  sectionDurationMinutes?: number;
  questions: RawMockQuestion[];
  passages: RawMockPassage[];
}

// POST /api/mock-results (and what GET /api/mock-results echoes back) uses
// these field names — testId (not mockId), overallScaledScore/totalScore
// (not totalScaledScore), timeSpent (not totalTimeSpent), submittedAt (not
// completedAt). sectionOrder isn't part of the official sheet schema, so it
// only survives when the server is running on the local JSON fallback.
interface RawMockResult {
  id: string;
  studentId: string;
  testId: string;
  totalScore?: number;
  overallScaledScore?: number;
  percentile?: number;
  sectionResults: Record<GmatSection, SectionResult>;
  studentAnswers?: AnswersMap;
  timeSpent?: number;
  submittedAt: string;
  sectionOrder?: GmatSection[];
}

// ─────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────

const SECTION_META: Record<
  GmatSection,
  { label: string; short: string; color: string; lightColor: string; textColor: string; borderColor: string; questions: number; minutes: number }
> = {
  Quant: {
    label: "Quantitative Reasoning",
    short: "Quant",
    color: "bg-emerald-500",
    lightColor: "bg-emerald-50",
    textColor: "text-emerald-700",
    borderColor: "border-emerald-200",
    questions: 21,
    minutes: 45,
  },
  Verbal: {
    label: "Verbal Reasoning",
    short: "Verbal",
    color: "bg-violet-500",
    lightColor: "bg-violet-50",
    textColor: "text-violet-700",
    borderColor: "border-violet-200",
    questions: 23,
    minutes: 45,
  },
  DataInsights: {
    label: "Data Insights",
    short: "DI",
    color: "bg-blue-500",
    lightColor: "bg-blue-50",
    textColor: "text-blue-700",
    borderColor: "border-blue-200",
    questions: 20,
    minutes: 45,
  },
};

const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  standard_mcq: "Multiple Choice",
  table_analysis: "Table Analysis",
  graphics_interpretation: "Graphics Interpretation",
  two_part_analysis: "Two-Part Analysis",
  multi_source_reasoning: "Multi-Source Reasoning",
};

const STIMULUS_KIND_LABELS: Record<StimulusKind, string> = {
  text: "Passage",
  table: "Data Table",
  chart: "Chart",
  tabs: "Sources",
};

// ─────────────────────────────────────────────────────────────────────────
// HELPERS — scoring
// ─────────────────────────────────────────────────────────────────────────

function calcTotalGmatScore(quantScore: number, verbalScore: number, diScore: number): number {
  const sum = quantScore + verbalScore + diScore; // Min 180, Max 270
  const normalized = (sum - 180) / 90; // 0.0 to 1.0
  const total = 205 + Math.round(normalized * 60) * 10;
  return Math.min(805, Math.max(205, total));
}

function calcScaledSectionScore(correct: number, total: number): number {
  if (total === 0) return 60;
  return Math.round(60 + (correct / total) * 30);
}

function emptyAnswerFor(q: SectionalQuestion): QuestionAnswer {
  switch (q.questionType) {
    case "table_analysis":
      return { kind: "statements", values: {} };
    case "graphics_interpretation":
      return { kind: "blanks", values: {} };
    case "two_part_analysis":
      return { kind: "twoPart" };
    case "multi_source_reasoning":
      return q.statements?.length ? { kind: "statements", values: {} } : { kind: "single", value: "" };
    default:
      return { kind: "single", value: "" };
  }
}

function isAnswerComplete(q: SectionalQuestion, ans?: QuestionAnswer): boolean {
  if (!ans) return false;
  switch (ans.kind) {
    case "single":
      return !!ans.value;
    case "statements": {
      const required = q.statements?.map((s) => s.id) ?? [];
      return required.length > 0 && required.every((id) => !!ans.values[id]);
    }
    case "blanks": {
      const required = q.blanks?.map((b) => b.id) ?? [];
      return required.length > 0 && required.every((id) => !!ans.values[id]);
    }
    case "twoPart":
      return !!ans.part1 && !!ans.part2;
  }
}

function isAnswerCorrect(q: SectionalQuestion, ans?: QuestionAnswer): boolean {
  if (!ans) return false;
  switch (ans.kind) {
    case "single":
      return ans.value === q.correctAnswer;
    case "statements":
      return (q.statements ?? []).every((s) => ans.values[s.id] === s.correctAnswer);
    case "blanks":
      return (q.blanks ?? []).every((b) => ans.values[b.id] === b.correctChoice);
    case "twoPart":
      return ans.part1 === q.correctPart1 && ans.part2 === q.correctPart2;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS — server-shape adapters
// ─────────────────────────────────────────────────────────────────────────

function unwrapMockQuestion(raw: RawMockQuestion): SectionalQuestion {
  const { typeData, ...rest } = raw;
  return {
    ...(rest as SectionalQuestion),
    ...(typeData || {}),
  };
}

function unwrapMockPassage(raw: RawMockPassage): Stimulus {
  if (raw.kind === "table") {
    return { id: raw.id, title: raw.title, kind: "table", table: raw.table ?? (raw.data as StimulusTable) };
  }
  if (raw.kind === "tabs") {
    return { id: raw.id, title: raw.title, kind: "tabs", tabs: raw.tabs ?? (raw.data as StimulusTab[]) };
  }
  if (raw.kind === "chart") {
    return { id: raw.id, title: raw.title, kind: "chart", chartImageUrl: raw.chartImageUrl };
  }
  return { id: raw.id, title: raw.title, kind: "text", text: raw.text };
}

function buildFullMockTest(raw: RawMockTestDetail): FullMockTest {
  const rawQuestions = raw.questions || [];
  const passages = (raw.passages || []).map(unwrapMockPassage);
  const sectionDuration = raw.sectionDurationMinutes || 45;

  const makeSection = (sec: GmatSection): SectionalTest => ({
    id: `${raw.id}-${sec}`,
    name: `${raw.name} — ${SECTION_META[sec].label}`,
    section: sec,
    durationMinutes: sectionDuration,
    questions: rawQuestions.filter((q) => q.section === sec).map(unwrapMockQuestion),
    passages,
  });

  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    quantSection: makeSection("Quant"),
    verbalSection: makeSection("Verbal"),
    dataInsightsSection: makeSection("DataInsights"),
  };
}

function adaptMockResult(r: RawMockResult): FullMockResult {
  return {
    mockId: r.testId,
    totalScaledScore: r.overallScaledScore ?? r.totalScore ?? 0,
    sectionOrder: r.sectionOrder || (Object.keys(r.sectionResults || {}) as GmatSection[]),
    sectionResults: r.sectionResults || ({} as Record<GmatSection, SectionResult>),
    totalTimeSpent: r.timeSpent || 0,
    completedAt: r.submittedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS — misc
// ─────────────────────────────────────────────────────────────────────────

function MultiParagraphLatex({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  const paras = text.split("\n\n");
  return (
    <>
      {paras.map((para, i) => (
        <p key={i} className={i > 0 ? `mt-2 ${className || ""}` : className}>
          <Latex>{para}</Latex>
        </p>
      ))}
    </>
  );
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const IMAGE_URL_REGEX =
  /(?:!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|\[image:\s*(https?:\/\/[^\]]+)\]|(https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?[^\s]*)?(?=#|\s|$)))/gi;

type Segment = { type: "text"; content: string } | { type: "image"; url: string; alt?: string };

function parseSegments(text: string): Segment[] {
  const normalized = text.replace(/\\n/g, "\n");
  const segments: Segment[] = [];
  let lastIndex = 0;
  IMAGE_URL_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMAGE_URL_REGEX.exec(normalized)) !== null) {
    const [fullMatch, mdAlt, mdUrl, tagUrl, bareUrl] = match;
    const url = mdUrl || tagUrl || bareUrl;
    const alt = mdAlt || undefined;
    if (match.index > lastIndex) segments.push({ type: "text", content: normalized.slice(lastIndex, match.index) });
    segments.push({ type: "image", url: url.trim(), alt });
    lastIndex = match.index + fullMatch.length;
  }
  if (lastIndex < normalized.length) segments.push({ type: "text", content: normalized.slice(lastIndex) });
  return segments;
}

function StimulusImage({ url, alt }: { url: string; alt?: string }) {
  const [lightbox, setLightbox] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  if (error) {
    return (
      <div className="my-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600">
        <span>⚠️ Image failed to load:</span>
        <a href={url} target="_blank" rel="noopener noreferrer" className="underline truncate max-w-[200px]">
          {url}
        </a>
      </div>
    );
  }

  return (
    <>
      <div className="my-3 relative group">
        {!loaded && (
          <div className="h-24 rounded-lg bg-secondary/40 animate-pulse flex items-center justify-center text-xs text-muted-foreground">
            Loading image…
          </div>
        )}
        <img
          src={url}
          alt={alt || "Stimulus image"}
          className={`max-w-full rounded-lg border border-border shadow-sm cursor-zoom-in transition-opacity ${
            loaded ? "opacity-100" : "opacity-0 absolute inset-0"
          }`}
          style={{ maxHeight: "320px", objectFit: "contain" }}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(true);
            setError(true);
          }}
          onClick={() => setLightbox(true)}
        />
        {loaded && !error && (
          <button
            onClick={() => setLightbox(true)}
            className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity"
            title="View full size"
          >
            <ZoomIn size={14} />
          </button>
        )}
      </div>
      {lightbox && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setLightbox(false)}>
          <button className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20" onClick={() => setLightbox(false)}>
            <X size={20} />
          </button>
          <img src={url} alt={alt || "Stimulus image"} className="max-w-full max-h-[90vh] rounded-lg shadow-2xl object-contain" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </>
  );
}

function RichText({ text }: { text: string }) {
  const segments = parseSegments(text || "");
  return (
    <div className="space-y-1">
      {segments.map((seg, i) =>
        seg.type === "image" ? (
          <StimulusImage key={i} url={seg.url} alt={seg.alt} />
        ) : (
          <div key={i}>
            {seg.content
              .split("\n\n")
              .map((p) => p.trim())
              .filter(Boolean)
              .map((p, j) => (
                <p key={j} className="mb-2 last:mb-0">
                  {p}
                </p>
              ))}
          </div>
        )
      )}
    </div>
  );
}

function isTableContent(content: string | StimulusTable): content is StimulusTable {
  return typeof content === "object" && content !== null && Array.isArray((content as StimulusTable).columns);
}

function SortableTable({ columns, rows }: StimulusTable) {
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc" | null>(null);

  const sortedRows = useMemo(() => {
    if (sortCol === null || sortDir === null) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortCol];
      const bv = b[sortCol];
      const an = typeof av === "number" ? av : parseFloat(String(av));
      const bn = typeof bv === "number" ? bv : parseFloat(String(bv));
      const cmp = !isNaN(an) && !isNaN(bn) ? an - bn : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortCol, sortDir]);

  const handleHeaderClick = (idx: number) => {
    if (sortCol !== idx) {
      setSortCol(idx);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortCol(null);
      setSortDir(null);
    }
  };

  return (
    <div className="border rounded-xl overflow-hidden">
      <div className="overflow-x-auto max-h-72 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-secondary/60 backdrop-blur z-10">
            <tr>
              {columns.map((col, idx) => {
                const isActive = sortCol === idx;
                return (
                  <th
                    key={col}
                    onClick={() => handleHeaderClick(idx)}
                    className={`px-3 py-2 text-left font-bold text-xs uppercase tracking-wide cursor-pointer select-none whitespace-nowrap hover:bg-secondary transition-colors ${
                      isActive ? "text-primary" : "text-muted-foreground"
                    }`}
                    title="Click to sort"
                  >
                    <span className="inline-flex items-center gap-1">
                      {col}
                      {isActive ? (
                        sortDir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />
                      ) : (
                        <ArrowUpDown size={12} className="opacity-30" />
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, rIdx) => (
              <tr key={rIdx} className={rIdx % 2 === 0 ? "bg-background" : "bg-secondary/20"}>
                {row.map((cell, cIdx) => (
                  <td key={cIdx} className="px-3 py-2 border-t whitespace-nowrap">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-1.5 bg-secondary/30 border-t text-[11px] text-muted-foreground">
        Click a column header to sort · click again to reverse · a third click resets order
      </div>
    </div>
  );
}

function SourceTabs({ tabs }: { tabs: StimulusTab[] }) {
  const [active, setActive] = useState(0);
  if (!tabs?.length) return null;
  return (
    <div className="border rounded-xl overflow-hidden">
      <div className="flex border-b bg-secondary/40 overflow-x-auto">
        {tabs.map((t, idx) => (
          <button
            key={t.label}
            onClick={() => setActive(idx)}
            className={`px-4 py-2 text-xs font-bold uppercase tracking-wide transition-colors whitespace-nowrap ${
              active === idx ? "bg-background text-primary border-b-2 border-primary" : "text-muted-foreground hover:bg-secondary/60"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="p-4 text-sm leading-relaxed max-h-72 overflow-y-auto">
        {tabs[active] && isTableContent(tabs[active].content) ? (
          <SortableTable columns={(tabs[active].content as StimulusTable).columns} rows={(tabs[active].content as StimulusTable).rows} />
        ) : (
          <RichText text={(tabs[active]?.content as string) ?? ""} />
        )}
      </div>
    </div>
  );
}

function StimulusBoard({ stimulus }: { stimulus: Stimulus }) {
  switch (stimulus.kind) {
    case "text":
      return (
        <div className="text-sm leading-relaxed text-muted-foreground max-h-56 overflow-y-auto pr-2">
          <RichText text={stimulus.text ?? ""} />
        </div>
      );
    case "table":
      return stimulus.table ? <SortableTable columns={stimulus.table.columns} rows={stimulus.table.rows} /> : null;
    case "chart":
      return stimulus.chartImageUrl ? <StimulusImage url={stimulus.chartImageUrl} alt={stimulus.title} /> : null;
    case "tabs":
      return stimulus.tabs ? <SourceTabs tabs={stimulus.tabs} /> : null;
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ANSWER WIDGETS
// ─────────────────────────────────────────────────────────────────────────

function OptionPicker({
  options,
  value,
  onSelect,
  disabled,
}: {
  options: string[];
  value: string;
  onSelect: (val: string) => void;
  disabled?: boolean;
}) {
  return (
    <RadioGroup value={value} onValueChange={onSelect}>
      {options.filter(Boolean).map((opt, idx) => {
        const isSelected = value === opt;
        const blocked = disabled && !isSelected;
        return (
          <Label
            key={opt}
            className={`flex items-center gap-3 p-3.5 rounded-xl border-2 transition-all ${
              blocked ? "cursor-not-allowed opacity-50" : "cursor-pointer"
            } ${isSelected ? "border-primary bg-blue-50 ring-1 ring-primary" : "border-border hover:border-primary/30 hover:bg-secondary/30"}`}
          >
            <RadioGroupItem value={opt} className="sr-only" disabled={blocked} />
            <div
              className={`w-7 h-7 shrink-0 rounded-lg flex items-center justify-center font-bold text-xs border ${
                isSelected ? "bg-primary text-primary-foreground border-primary" : "bg-secondary text-muted-foreground border-border"
              }`}
            >
              {String.fromCharCode(65 + idx)}
            </div>
            <span className="text-sm">
              <Latex>{opt}</Latex>
            </span>
          </Label>
        );
      })}
    </RadioGroup>
  );
}

function StatementGrid({
  statements,
  values,
  onSelect,
  disabled,
}: {
  statements: StatementRow[];
  values: Record<string, string>;
  onSelect: (stId: string, val: "Yes" | "No") => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      {statements.map((s, idx) => (
        <div key={s.id} className="flex items-center justify-between gap-3 p-3 rounded-xl border">
          <span className="text-sm flex-1">
            <span className="font-bold text-muted-foreground mr-1">{idx + 1}.</span>
            {s.text}
          </span>
          <div className="flex gap-1.5 shrink-0">
            {(["Yes", "No"] as const).map((opt) => (
              <button
                key={opt}
                disabled={disabled}
                onClick={() => onSelect(s.id, opt)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition-colors ${
                  values[s.id] === opt ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:border-primary/40"
                } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function GraphicsBlanksSentence({
  text,
  blanks,
  values,
  onSelect,
  disabled,
}: {
  text: string;
  blanks: DropdownBlank[];
  values: Record<string, string>;
  onSelect: (blankId: string, val: string) => void;
  disabled?: boolean;
}) {
  const tokenRe = /\{\{(\w+)\}\}/g;
  const hasTokens = /\{\{(\w+)\}\}/.test(text);

  const dropdown = (b: DropdownBlank) => (
    <select
      key={b.id}
      disabled={disabled}
      value={values[b.id] || ""}
      onChange={(e) => onSelect(b.id, e.target.value)}
      className={`mx-1 border-2 rounded-lg px-2 py-1 text-sm font-semibold bg-background ${
        values[b.id] ? "border-primary bg-blue-50" : "border-dashed border-muted-foreground/40"
      } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
    >
      <option value="" disabled>
        Select…
      </option>
      {b.choices.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );

  if (!hasTokens) {
    return (
      <div className="space-y-3">
        <p className="text-sm">{text}</p>
        <div className="flex flex-wrap gap-4">
          {blanks.map((b, idx) => (
            <div key={b.id} className="flex items-center gap-2">
              <span className="text-xs font-bold text-muted-foreground">Blank {idx + 1}</span>
              {dropdown(b)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    const blank = blanks.find((b) => b.id === m![1]);
    if (blank) parts.push(dropdown(blank));
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));

  return <p className="text-sm leading-loose">{parts}</p>;
}

function TwoPartGrid({
  options,
  part1,
  part2,
  onSelectPart1,
  onSelectPart2,
  disabled,
}: {
  options: string[];
  part1?: string;
  part2?: string;
  onSelectPart1: (val: string) => void;
  onSelectPart2: (val: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="border rounded-xl overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-secondary/60">
          <tr>
            <th className="px-3 py-2 text-left text-xs font-bold uppercase text-muted-foreground">Value</th>
            <th className="px-3 py-2 text-center text-xs font-bold uppercase text-muted-foreground">Part 1</th>
            <th className="px-3 py-2 text-center text-xs font-bold uppercase text-muted-foreground">Part 2</th>
          </tr>
        </thead>
        <tbody>
          {options.map((opt, idx) => (
            <tr key={opt} className={idx % 2 === 0 ? "bg-background" : "bg-secondary/20"}>
              <td className="px-3 py-2 border-t font-medium">
                <Latex>{opt}</Latex>
              </td>
              <td className="px-3 py-2 border-t text-center">
                <input
                  type="radio"
                  name="two-part-1"
                  disabled={disabled}
                  checked={part1 === opt}
                  onChange={() => onSelectPart1(opt)}
                  className="w-4 h-4 accent-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                />
              </td>
              <td className="px-3 py-2 border-t text-center">
                <input
                  type="radio"
                  name="two-part-2"
                  disabled={disabled}
                  checked={part2 === opt}
                  onChange={() => onSelectPart2(opt)}
                  className="w-4 h-4 accent-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QuestionBody({
  question,
  answer,
  disabled,
  onSelectSingle,
  onSelectStatement,
  onSelectBlank,
  onSelectPart1,
  onSelectPart2,
}: {
  question: SectionalQuestion;
  answer?: QuestionAnswer;
  disabled?: boolean;
  onSelectSingle: (val: string) => void;
  onSelectStatement: (stId: string, val: "Yes" | "No") => void;
  onSelectBlank: (blankId: string, val: string) => void;
  onSelectPart1: (val: string) => void;
  onSelectPart2: (val: string) => void;
}) {
  switch (question.questionType) {
    case "table_analysis": {
      const values = answer?.kind === "statements" ? answer.values : {};
      return <StatementGrid statements={question.statements ?? []} values={values} onSelect={onSelectStatement} disabled={disabled} />;
    }
    case "graphics_interpretation": {
      const values = answer?.kind === "blanks" ? answer.values : {};
      return (
        <GraphicsBlanksSentence
          text={question.questionText}
          blanks={question.blanks ?? []}
          values={values}
          onSelect={onSelectBlank}
          disabled={disabled}
        />
      );
    }
    case "two_part_analysis": {
      const part1 = answer?.kind === "twoPart" ? answer.part1 : undefined;
      const part2 = answer?.kind === "twoPart" ? answer.part2 : undefined;
      return (
        <TwoPartGrid
          options={question.twoPartOptions ?? []}
          part1={part1}
          part2={part2}
          onSelectPart1={onSelectPart1}
          onSelectPart2={onSelectPart2}
          disabled={disabled}
        />
      );
    }
    case "multi_source_reasoning": {
      if (question.statements?.length) {
        const values = answer?.kind === "statements" ? answer.values : {};
        return <StatementGrid statements={question.statements} values={values} onSelect={onSelectStatement} disabled={disabled} />;
      }
      const value = answer?.kind === "single" ? answer.value : "";
      return <OptionPicker options={question.options ?? []} value={value} onSelect={onSelectSingle} disabled={disabled} />;
    }
    default: {
      const value = answer?.kind === "single" ? answer.value : "";
      return <OptionPicker options={question.options ?? []} value={value} onSelect={onSelectSingle} disabled={disabled} />;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────

export default function gmatMockTests({ user }: { user: any }) {
  const [view, setView] = useState<"list" | "orderSelect" | "testing" | "break" | "result">("list");
  const [availableMocks, setAvailableMocks] = useState<MockTestSummary[]>([]);
  const [selectedMock, setSelectedMock] = useState<FullMockTest | null>(null);
  const [mockResults, setMockResults] = useState<Record<string, FullMockResult>>({});
  const [loading, setLoading] = useState(true);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);

  // Workflow sequence state
  const [sectionOrder, setSectionOrder] = useState<GmatSection[]>(["Quant", "Verbal", "DataInsights"]);
  const [currentSectionIdx, setCurrentSectionIdx] = useState(0);
  const [breakTimeLeft, setBreakTimeLeft] = useState(600); // 10 minutes optional break
  const [breakTaken, setBreakTaken] = useState(false);

  // Section Test Runtime State
  const [currentQIdx, setCurrentQIdx] = useState(0);
  const [sectionAnswers, setSectionAnswers] = useState<AnswersMap>({});
  const [flaggedQs, setFlaggedQs] = useState<Set<string>>(new Set());
  const [sectionTimeLeft, setSectionTimeLeft] = useState(45 * 60);
  const [completedSectionResults, setCompletedSectionResults] = useState<Partial<Record<GmatSection, SectionResult>>>({});
  const [activeStimulus, setActiveStimulus] = useState<Stimulus | null>(null);

  const activeSectionType = sectionOrder[currentSectionIdx];

  const currentSectionData = useMemo(() => {
    if (!selectedMock || !activeSectionType) return null;
    if (activeSectionType === "Quant") return selectedMock.quantSection;
    if (activeSectionType === "Verbal") return selectedMock.verbalSection;
    return selectedMock.dataInsightsSection;
  }, [selectedMock, activeSectionType]);

  const questionById = useMemo(() => {
    const map: Record<string, SectionalQuestion> = {};
    (currentSectionData?.questions ?? []).forEach((q) => (map[q.id] = q));
    return map;
  }, [currentSectionData]);

  // Fetch Mocks — these paths match the routes actually registered on the
  // server (/api/mock-tests, /api/mock-results).
  useEffect(() => {
    async function loadData() {
      try {
        const [mocks, results] = await Promise.all([apiRequest("/mock-tests"), apiRequest("/mock-results")]);
        setAvailableMocks(mocks || []);
        const resMap: Record<string, FullMockResult> = {};
        (results || []).forEach((r: RawMockResult) => {
          resMap[r.testId] = adaptMockResult(r);
        });
        setMockResults(resMap);
      } catch {
        toast.error("Failed to load mock tests");
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  // Section Timer
  useEffect(() => {
    if (view !== "testing" || sectionTimeLeft <= 0) return;
    const t = setInterval(() => setSectionTimeLeft((prev) => prev - 1), 1000);
    return () => clearInterval(t);
  }, [view, sectionTimeLeft]);

  // Break Timer
  useEffect(() => {
    if (view !== "break" || breakTimeLeft <= 0) return;
    const t = setInterval(() => setBreakTimeLeft((prev) => prev - 1), 1000);
    return () => clearInterval(t);
  }, [view, breakTimeLeft]);

  // Auto-submit Section on Timeout
  useEffect(() => {
    if (view === "testing" && sectionTimeLeft === 0) {
      toast.warning("Section time expired! Submitting section...");
      completeCurrentSection();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionTimeLeft]);

  // Active stimulus for whichever question is currently on screen — this is
  // what was missing entirely before, so passages never rendered no matter
  // the section.
  useEffect(() => {
    if (!currentSectionData || view !== "testing") return;
    const q = currentSectionData.questions[currentQIdx];
    if (q?.passageId && currentSectionData.passages) {
      setActiveStimulus(currentSectionData.passages.find((s) => s.id === q.passageId) || null);
    } else {
      setActiveStimulus(null);
    }
  }, [currentQIdx, currentSectionData, view]);

  // Fetches the full question set for a mock (GET /api/mock-test/:id) and
  // builds the three-section FullMockTest shape the rest of the component
  // expects.
  const fetchFullMock = async (mockId: string): Promise<FullMockTest | null> => {
    setDetailLoadingId(mockId);
    try {
      const detail = await apiRequest(`/mock-test/${mockId}`);
      return buildFullMockTest(detail);
    } catch {
      toast.error("Failed to load this mock test's questions");
      return null;
    } finally {
      setDetailLoadingId(null);
    }
  };

  const handleStartMockConfig = async (mock: MockTestSummary) => {
    const full = await fetchFullMock(mock.id);
    if (!full) return;
    setSelectedMock(full);
    setSectionOrder(["Quant", "Verbal", "DataInsights"]);
    setView("orderSelect");
  };

  // The backend only allows one attempt per student per mock test
  // (POST /api/mock-results returns a 400 on a second submission for the
  // same testId), so a completed mock can only be reviewed, not retaken.
  const handleViewReport = async (mock: MockTestSummary) => {
    const full = await fetchFullMock(mock.id);
    if (!full) return;
    setSelectedMock(full);
    setView("result");
  };

  const startFullMock = () => {
    setCurrentSectionIdx(0);
    setCompletedSectionResults({});
    setBreakTaken(false);
    initiateSection(0);
  };

  const initiateSection = (secIndex: number) => {
    const secType = sectionOrder[secIndex];
    let secData: SectionalTest | undefined;
    if (secType === "Quant") secData = selectedMock?.quantSection;
    else if (secType === "Verbal") secData = selectedMock?.verbalSection;
    else secData = selectedMock?.dataInsightsSection;

    setCurrentQIdx(0);
    setSectionAnswers({});
    setFlaggedQs(new Set());
    setActiveStimulus(null);
    setSectionTimeLeft((secData?.durationMinutes || 45) * 60);
    setView("testing");
  };

  const toggleFlag = useCallback((qId: string) => {
    setFlaggedQs((prev) => {
      const next = new Set(prev);
      next.has(qId) ? next.delete(qId) : next.add(qId);
      return next;
    });
  }, []);

  const changeAnswer = (qId: string, mutate: (prev: QuestionAnswer) => QuestionAnswer) => {
    const q = questionById[qId];
    if (!q) return;
    setSectionAnswers((prev) => {
      const current = prev[qId] ?? emptyAnswerFor(q);
      return { ...prev, [qId]: mutate(current) };
    });
  };

  const setSingle = (qId: string, val: string) => changeAnswer(qId, () => ({ kind: "single", value: val }));
  const setStatement = (qId: string, stId: string, val: "Yes" | "No") =>
    changeAnswer(qId, (prev) => ({
      kind: "statements",
      values: { ...(prev.kind === "statements" ? prev.values : {}), [stId]: val },
    }));
  const setBlank = (qId: string, blankId: string, val: string) =>
    changeAnswer(qId, (prev) => ({
      kind: "blanks",
      values: { ...(prev.kind === "blanks" ? prev.values : {}), [blankId]: val },
    }));
  const setPart1 = (qId: string, val: string) =>
    changeAnswer(qId, (prev) => ({ kind: "twoPart", part1: val, part2: prev.kind === "twoPart" ? prev.part2 : undefined }));
  const setPart2 = (qId: string, val: string) =>
    changeAnswer(qId, (prev) => ({ kind: "twoPart", part2: val, part1: prev.kind === "twoPart" ? prev.part1 : undefined }));

  const completeCurrentSection = () => {
    if (!currentSectionData) return;

    let correct = 0,
      wrong = 0,
      skipped = 0;
    currentSectionData.questions.forEach((q) => {
      const ans = sectionAnswers[q.id];
      if (!isAnswerComplete(q, ans)) {
        skipped++;
      } else if (isAnswerCorrect(q, ans)) {
        correct++;
      } else {
        wrong++;
      }
    });

    const scaledScore = calcScaledSectionScore(correct, currentSectionData.questions.length);
    const timeSpent = currentSectionData.durationMinutes * 60 - sectionTimeLeft;

    const secResult: SectionResult = {
      section: activeSectionType,
      scaledScore,
      correct,
      wrong,
      skipped,
      timeSpent,
      studentAnswers: sectionAnswers,
    };

    const updatedResults = { ...completedSectionResults, [activeSectionType]: secResult };
    setCompletedSectionResults(updatedResults);

    // Check if exam complete or prompt optional break
    if (currentSectionIdx < 2) {
      if (!breakTaken) {
        setBreakTimeLeft(600); // 10 minutes
        setView("break");
      } else {
        setCurrentSectionIdx((idx) => idx + 1);
        initiateSection(currentSectionIdx + 1);
      }
    } else {
      finalizeMockTest(updatedResults);
    }
  };

  const finalizeMockTest = async (finalSecResults: Partial<Record<GmatSection, SectionResult>>) => {
    if (!selectedMock) return;

    const qRes = finalSecResults["Quant"]?.scaledScore || 60;
    const vRes = finalSecResults["Verbal"]?.scaledScore || 60;
    const diRes = finalSecResults["DataInsights"]?.scaledScore || 60;

    const totalScaledScore = calcTotalGmatScore(qRes, vRes, diRes);
    const totalTimeSpent = Object.values(finalSecResults).reduce((acc, curr) => acc + (curr?.timeSpent || 0), 0);
    const mergedAnswers: AnswersMap = Object.values(finalSecResults).reduce(
      (acc, curr) => ({ ...acc, ...(curr?.studentAnswers || {}) }),
      {} as AnswersMap
    );

    // Field names here match SHEET_CONFIG.MockResults on the server
    // (testId, totalScore, overallScaledScore, sectionResults,
    // studentAnswers, timeSpent) so the row saves correctly whether the
    // backend is writing to the Google Sheet or the local JSON fallback.
    const resultPayload = {
      testId: selectedMock.id,
      totalScore: qRes + vRes + diRes,
      overallScaledScore: totalScaledScore,
      sectionResults: finalSecResults,
      studentAnswers: mergedAnswers,
      timeSpent: totalTimeSpent,
      sectionOrder,
    };

    try {
      const saved: RawMockResult = await apiRequest("/mock-results", {
        method: "POST",
        body: JSON.stringify(resultPayload),
      });
      setMockResults((prev) => ({ ...prev, [selectedMock.id]: adaptMockResult(saved) }));
      setView("result");
      toast.success("Full Mock Test Completed!");
    } catch (err: any) {
      const alreadyAttempted = /already attempted/i.test(err?.message || "");
      toast.error(alreadyAttempted ? "This mock test was already submitted once." : "Failed to save full exam result.");
      // Still show the score locally even though the save failed/was
      // rejected, rather than falling through to a blank screen.
      setMockResults((prev) => ({
        ...prev,
        [selectedMock.id]: {
          mockId: selectedMock.id,
          totalScaledScore,
          sectionOrder,
          sectionResults: finalSecResults as Record<GmatSection, SectionResult>,
          totalTimeSpent,
          completedAt: new Date().toISOString(),
        },
      }));
      setView("result");
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24">
        <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // 1. LIST VIEW
  if (view === "list") {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Full-Length GMAT Focus Mock Tests</h1>
          <p className="text-muted-foreground mt-1">Simulate real 2 hr 15 min adaptive full exam experience with official section order customization.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {availableMocks.map((mock) => {
            const completed = mockResults[mock.id];
            return (
              <Card key={mock.id} className="hover:shadow-lg transition-all border-t-4 border-t-primary">
                <CardHeader>
                  <div className="flex justify-between items-center">
                    <Badge variant={completed ? "default" : "secondary"}>{completed ? "Completed" : "Available"}</Badge>
                    <span className="text-xs text-muted-foreground font-mono">135 mins total</span>
                  </div>
                  <CardTitle className="mt-2 text-xl">{mock.name}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-xs text-muted-foreground">{mock.description || "Contains Quant (21Q), Verbal (23Q), and Data Insights (20Q) full test set."}</p>

                  {completed ? (
                    <div className="p-3 bg-secondary/40 rounded-xl text-center">
                      <p className="text-[10px] font-bold uppercase text-muted-foreground">Total GMAT Score</p>
                      <p className="text-3xl font-black text-primary">{completed.totalScaledScore}</p>
                    </div>
                  ) : (
                    <div className="text-xs space-y-1 text-muted-foreground">
                      <p>• 3 Sections (45 min each)</p>
                      <p>• 1 Optional 10-Minute Break</p>
                    </div>
                  )}

                  {/* Each student gets one attempt per mock (enforced by
                      the server), so a completed mock opens the score
                      report instead of restarting the exam. */}
                  <Button
                    className="w-full gap-2"
                    disabled={detailLoadingId === mock.id}
                    onClick={() => (completed ? handleViewReport(mock) : handleStartMockConfig(mock))}
                  >
                    {detailLoadingId === mock.id ? (
                      <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    ) : completed ? (
                      <Eye size={16} />
                    ) : (
                      <Play size={16} />
                    )}
                    {completed ? "View Score Report" : "Start Mock Exam"}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    );
  }

  // 2. SECTION ORDER SELECTION VIEW
  if (view === "orderSelect" && selectedMock) {
    return (
      <div className="max-w-xl mx-auto space-y-6 py-8">
        <Card className="border-2 border-primary/20">
          <CardHeader>
            <CardTitle className="text-2xl">Select Your Section Order</CardTitle>
            <p className="text-xs text-muted-foreground">Just like on the real GMAT Focus Edition, choose the order you want to attempt the sections.</p>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3">
              {[
                ["Quant", "Verbal", "DataInsights"],
                ["Verbal", "Quant", "DataInsights"],
                ["DataInsights", "Verbal", "Quant"],
                ["Quant", "DataInsights", "Verbal"],
              ].map((order, idx) => (
                <button
                  key={idx}
                  onClick={() => setSectionOrder(order as GmatSection[])}
                  className={`w-full p-4 rounded-xl border-2 text-left font-bold text-sm flex items-center justify-between transition-all ${
                    JSON.stringify(sectionOrder) === JSON.stringify(order)
                      ? "border-primary bg-primary/5 text-primary"
                      : "border-border hover:border-primary/40"
                  }`}
                >
                  <span>{order.map((s) => SECTION_META[s as GmatSection].short).join(" → ")}</span>
                  {JSON.stringify(sectionOrder) === JSON.stringify(order) && <CheckCircle2 size={18} />}
                </button>
              ))}
            </div>

            <Button className="w-full" size="lg" onClick={startFullMock}>
              Confirm Order & Begin Full Exam
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // 3. OPTIONAL BREAK VIEW
  if (view === "break") {
    return (
      <div className="max-w-md mx-auto py-16 text-center space-y-6">
        <Card className="p-8 border-2 border-orange-200 bg-orange-50/30">
          <Coffee className="w-12 h-12 text-orange-500 mx-auto" />
          <h2 className="text-2xl font-bold mt-4">Optional 10-Minute Break</h2>
          <p className="text-xs text-muted-foreground mt-1">Section {currentSectionIdx + 1} completed. Take a rest before your next section.</p>

          <div className="my-6 text-4xl font-mono font-black text-orange-600">
            {Math.floor(breakTimeLeft / 60)}:{(breakTimeLeft % 60).toString().padStart(2, "0")}
          </div>

          <Button
            className="w-full"
            onClick={() => {
              setBreakTaken(true);
              setCurrentSectionIdx((i) => i + 1);
              initiateSection(currentSectionIdx + 1);
            }}
          >
            End Break & Start Section {currentSectionIdx + 2}
          </Button>
        </Card>
      </div>
    );
  }

  // 4. TEST ATTEMPT VIEW
  if (view === "testing" && currentSectionData) {
    const q = currentSectionData.questions[currentQIdx];
    const meta = SECTION_META[activeSectionType];
    const answeredCount = currentSectionData.questions.filter((qq) => isAnswerComplete(qq, sectionAnswers[qq.id])).length;
    const progress = (answeredCount / currentSectionData.questions.length) * 100;
    const showHeaderPrompt = q?.questionType !== "graphics_interpretation";

    if (!q) return null;

    return (
      <div className="max-w-4xl mx-auto space-y-4 py-4">
        {/* Exam Header Bar */}
        <div className="flex justify-between items-center bg-card p-4 rounded-xl border shadow-sm">
          <Badge className={`${meta.color} text-white border-none`}>{meta.label}</Badge>
          <div className="flex items-center gap-4 text-sm font-bold font-mono">
            <Clock size={16} />
            {formatTime(sectionTimeLeft)}
          </div>
        </div>
        <Progress value={progress} className="h-1" />

        {/* Passage / stimulus, when this question references one — this is
            what was missing before, causing passages to never appear. */}
        {activeStimulus && (
          <Card className="border-l-4 border-l-violet-400">
            <CardHeader className="pb-2">
              <span className="text-xs font-bold uppercase text-muted-foreground tracking-wide">
                {STIMULUS_KIND_LABELS[activeStimulus.kind]} · {activeStimulus.title}
              </span>
            </CardHeader>
            <CardContent>
              <StimulusBoard stimulus={activeStimulus} />
            </CardContent>
          </Card>
        )}

        {/* Question View */}
        <Card>
          <CardHeader>
            <div className="flex justify-between items-center flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold text-muted-foreground">
                  Question {currentQIdx + 1} of {currentSectionData.questions.length}
                </span>
                <Badge variant="outline" className="text-[10px]">
                  {QUESTION_TYPE_LABELS[q.questionType]}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggleFlag(q.id)}
                  className={`p-1.5 rounded-lg transition-colors ${
                    flaggedQs.has(q.id) ? "text-orange-500 bg-orange-50" : "text-muted-foreground hover:bg-secondary"
                  }`}
                  title="Bookmark for review"
                >
                  <Flag size={16} fill={flaggedQs.has(q.id) ? "currentColor" : "none"} />
                </button>
                <Button variant="ghost" size="sm" onClick={() => completeCurrentSection()}>
                  End Section Early
                </Button>
              </div>
            </div>
            {showHeaderPrompt && (
              <CardTitle className="text-base mt-2 font-semibold leading-relaxed">
                <MultiParagraphLatex text={q.questionText} />
              </CardTitle>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <QuestionBody
              question={q}
              answer={sectionAnswers[q.id]}
              onSelectSingle={(val) => setSingle(q.id, val)}
              onSelectStatement={(stId, val) => setStatement(q.id, stId, val)}
              onSelectBlank={(blankId, val) => setBlank(q.id, blankId, val)}
              onSelectPart1={(val) => setPart1(q.id, val)}
              onSelectPart2={(val) => setPart2(q.id, val)}
            />

            <div className="flex justify-between items-center pt-4 border-t">
              <Button variant="outline" disabled={currentQIdx === 0} onClick={() => setCurrentQIdx((i) => i - 1)}>
                <ChevronLeft size={16} /> Previous
              </Button>
              {currentQIdx < currentSectionData.questions.length - 1 ? (
                <Button onClick={() => setCurrentQIdx((i) => i + 1)}>
                  Next <ChevronRight size={16} />
                </Button>
              ) : (
                <Button variant="destructive" onClick={completeCurrentSection}>
                  Finish Section
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // 5. FINAL EXAM SCORE CARD VIEW
  if (view === "result" && selectedMock && mockResults[selectedMock.id]) {
    const res = mockResults[selectedMock.id];
    return (
      <div className="max-w-3xl mx-auto space-y-6 py-6">
        <Button variant="ghost" onClick={() => setView("list")} className="gap-2">
          <ArrowLeft size={16} /> Back to Mock Tests
        </Button>

        <Card className="border-2 border-primary text-center">
          <CardHeader>
            <CardTitle className="text-sm font-bold text-muted-foreground uppercase">Official GMAT Focus Score Report</CardTitle>
            <h1 className="text-6xl font-black text-primary mt-2">{res.totalScaledScore}</h1>
            <p className="text-xs text-muted-foreground mt-1">Scale Range: 205 – 805</p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-4 border-t pt-4">
              {(["Quant", "Verbal", "DataInsights"] as GmatSection[]).map((sec) => (
                <div key={sec} className="p-3 bg-secondary/30 rounded-xl">
                  <p className="text-[10px] font-bold uppercase text-muted-foreground">{SECTION_META[sec].short}</p>
                  <p className="text-2xl font-black">{res.sectionResults[sec]?.scaledScore || 60}</p>
                  <p className="text-[10px] text-muted-foreground">Range: 60-90</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return null;
}
