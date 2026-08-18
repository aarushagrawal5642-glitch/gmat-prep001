import React, { useState, useEffect, useCallback, useRef } from "react";
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
  ListChecks,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { apiRequest } from "@/src/lib/api";

// ─── Types ────────────────────────────────────────────────────────────────────

// GMAT Focus Edition sections
type GmatSection = "Quant" | "Verbal" | "DataInsights";

interface SectionalQuestion {
  id: string;
  section: GmatSection;
  questionText: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  difficulty: "Easy" | "Medium" | "Hard";
  passageId?: string; // for RC / Multi-Source Reasoning passages
}

interface Passage {
  id: string;
  title: string;
  text: string;
}

interface SectionalTest {
  id: string;
  name: string;
  section: GmatSection;
  durationMinutes: number;
  questions: SectionalQuestion[];
  passages?: Passage[];
}

interface SectionalResult {
  testId: string;
  section: string;
  totalScore: number; // accuracy %
  correctAnswers: number;
  wrongAnswers: number;
  skippedQuestions: number;
  timeSpent: number;
  studentAnswers: Record<string, string>;
  scaledScore: number; // GMAT-style scaled score, 60–90
  editsUsed?: number; // how many of the 3 allowed answer changes were used
  reachedReview?: boolean; // whether the student reached the Review & Edit screen
}

// ─── Constants ────────────────────────────────────────────────────────────────
// GMAT Focus Edition: 3 sections, 45 minutes each, no negative marking,
// strictly sequential (no skipping), one Question Review & Edit screen per
// section that allows up to 3 answer changes — this mirrors the real exam's
// rules as documented by GMAC / mba.com.

const MAX_EDITS_PER_SECTION = 3;

const SECTION_META: Record<
  GmatSection,
  {
    label: string;
    short: string;
    color: string;
    lightColor: string;
    textColor: string;
    borderColor: string;
    questions: number;
    minutes: number;
  }
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

const SECTION_ORDER: GmatSection[] = ["Quant", "Verbal", "DataInsights"];

// ─── Helper ───────────────────────────────────────────────────────────────────
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

// GMAT Focus section scores are reported on a 60–90 scale in 1-point
// increments. GMAC's real item-adaptive algorithm is proprietary and can't
// be reproduced outside the live exam, so — same as every third-party GMAT
// prep tool — this maps raw accuracy onto that 60–90 band as a practice
// approximation (no negative marking, so it is purely accuracy-driven).
function calcScaledScore(correct: number, total: number) {
  if (total === 0) return 60;
  const accuracy = correct / total;
  return Math.round(60 + accuracy * 30);
}

const IMAGE_URL_REGEX = /(?:!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)|\[image:\s*(https?:\/\/[^\]]+)\]|(https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?[^\s]*)?(?=#|\s|$)))/gi;

type PassageSegment =
  | { type: "text"; content: string }
  | { type: "image"; url: string; alt?: string };

function parsePassageSegments(text: string): PassageSegment[] {
  const normalized = text.replace(/\\n/g, "\n");
  const segments: PassageSegment[] = [];
  let lastIndex = 0;

  IMAGE_URL_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = IMAGE_URL_REGEX.exec(normalized)) !== null) {
    const [fullMatch, mdAlt, mdUrl, tagUrl, bareUrl] = match;
    const url = mdUrl || tagUrl || bareUrl;
    const alt = mdAlt || undefined;

    if (match.index > lastIndex) {
      segments.push({ type: "text", content: normalized.slice(lastIndex, match.index) });
    }

    segments.push({ type: "image", url: url.trim(), alt });
    lastIndex = match.index + fullMatch.length;
  }

  if (lastIndex < normalized.length) {
    segments.push({ type: "text", content: normalized.slice(lastIndex) });
  }

  return segments;
}

// ─── Passage Image Lightbox ────────────────────────────────────────────────────

function PassageImage({ url, alt }: { url: string; alt?: string }) {
  const [lightbox, setLightbox] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  if (error) {
    return (
      <div className="my-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600">
        <span>⚠️ Image failed to load:</span>
        <a href={url} target="_blank" rel="noopener noreferrer" className="underline truncate max-w-[200px]">{url}</a>
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
          alt={alt || "Passage image"}
          className={`max-w-full rounded-lg border border-border shadow-sm cursor-zoom-in transition-opacity ${loaded ? "opacity-100" : "opacity-0 absolute inset-0"}`}
          style={{ maxHeight: "300px", objectFit: "contain" }}
          onLoad={() => setLoaded(true)}
          onError={() => { setLoaded(true); setError(true); }}
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
        {alt && loaded && !error && (
          <p className="text-[11px] text-center text-muted-foreground mt-1 italic">{alt}</p>
        )}
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightbox(false)}
        >
          <button
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20"
            onClick={() => setLightbox(false)}
          >
            <X size={20} />
          </button>
          <img
            src={url}
            alt={alt || "Passage image"}
            className="max-w-full max-h-[90vh] rounded-lg shadow-2xl object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

// ─── Passage Renderer ──────────────────────────────────────────────────────────

function PassageContent({ text }: { text: string }) {
  const segments = parsePassageSegments(text);

  return (
    <div className="space-y-1">
      {segments.map((seg, i) => {
        if (seg.type === "image") {
          return <PassageImage key={i} url={seg.url} alt={seg.alt} />;
        }
        return (
          <div key={i}>
            {seg.content
              .split("\n\n")
              .map((para, j) => para.trim())
              .filter(Boolean)
              .map((para, j) => (
                <p key={j} className="mb-2 last:mb-0">{para}</p>
              ))}
          </div>
        );
      })}
    </div>
  );
}

// ─── Question Status Dot (used on the Review & Edit palette) ─────────────────

function StatusDot({
  answered,
  flagged,
  current,
  idx,
  onClick,
}: {
  answered: boolean;
  flagged: boolean;
  current: boolean;
  idx: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-9 h-9 rounded-lg text-xs font-bold transition-all flex items-center justify-center relative
        ${current ? "ring-2 ring-offset-1 ring-primary scale-110" : ""}
        ${answered ? "bg-blue-500 text-white" : "bg-secondary text-muted-foreground hover:bg-secondary/80"}
      `}
    >
      {idx + 1}
      {flagged && (
        <span className="absolute -top-1 -right-1 w-3 h-3 bg-orange-400 rounded-full" />
      )}
    </button>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function sectionalTest({ user }: { user: any }) {
  const [view, setView] = useState<
    "list" | "instructions" | "test" | "reviewEdit" | "result"
  >("list");
  const [availableTests, setAvailableTests] = useState<SectionalTest[]>([]);
  const [attempts, setAttempts] = useState<Record<string, SectionalResult>>({});
  const [selectedTest, setSelectedTest] = useState<SectionalTest | null>(null);
  const [loading, setLoading] = useState(true);

  // Test state — strictly sequential, one question visible at a time
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [timeLeft, setTimeLeft] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState<SectionalResult | null>(null);
  const [activePassage, setActivePassage] = useState<Passage | null>(null);
  const [reviewMode, setReviewMode] = useState(false); // post-submission full review with explanations
  const [testLoading, setTestLoading] = useState(false);

  // Question Review & Edit (mid-section, pre-submission) state
  const [reviewIdx, setReviewIdx] = useState(0);
  const [editsUsed, setEditsUsed] = useState(0);
  const reachedReviewRef = useRef(false); // did the student legitimately reach the review screen?

  // ── Load tests ──────────────────────────────────────────────────────────────
  useEffect(() => {
    loadTests();
  }, []);

  const loadTests = async () => {
    setLoading(true);
    try {
      const [tests, prevResults] = await Promise.all([
        apiRequest("/sectional-tests"),
        apiRequest("/sectional-results"),
      ]);
      setAvailableTests(tests || []);
      const map: Record<string, SectionalResult> = {};
      (prevResults || []).forEach((r: SectionalResult) => {
        map[r.testId] = r;
      });
      setAttempts(map);
    } catch (err: any) {
      toast.error("Failed to load sectional tests");
    } finally {
      setLoading(false);
    }
  };

  // ── Timer (runs through both the sequential test AND the review/edit screen) ─
  useEffect(() => {
    if ((view !== "test" && view !== "reviewEdit") || submitted || timeLeft <= 0) return;
    const t = setInterval(() => setTimeLeft((p) => p - 1), 1000);
    return () => clearInterval(t);
  }, [view, submitted, timeLeft]);

  // Auto-submit when time hits 0, from either phase.
  // If time expires during the sequential phase, the Review & Edit screen is
  // skipped entirely — this matches the real GMAT Focus Edition behavior.
  useEffect(() => {
    if ((view === "test" || view === "reviewEdit") && !submitted && timeLeft === 0) {
      handleSubmit();
    }
  }, [timeLeft]);

  // ── Passage for the question currently on screen (test or review phase) ────
  const displayedIdx = view === "reviewEdit" ? reviewIdx : currentIdx;
  useEffect(() => {
    if (!selectedTest || (view !== "test" && view !== "reviewEdit")) return;
    const q = selectedTest.questions[displayedIdx];
    if (q?.passageId && selectedTest.passages) {
      setActivePassage(
        selectedTest.passages.find((p) => p.id === q.passageId) || null
      );
    } else {
      setActivePassage(null);
    }
  }, [displayedIdx, selectedTest, view]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const startTest = async (test: SectionalTest) => {
    if (attempts[test.id]) {
      setTestLoading(true);
      try {
        const fullTest = await apiRequest(`/sectional-test/${test.id}`);
        setSelectedTest(fullTest);
        setResult(attempts[test.id]);
        setAnswers(attempts[test.id].studentAnswers || {});
        setView("result");
      } catch {
        toast.error("Failed to load test");
      } finally {
        setTestLoading(false);
      }
      return;
    }

    setTestLoading(true);
    try {
      const fullTest = await apiRequest(`/sectional-test/${test.id}`);
      if (!fullTest?.questions?.length) {
        toast.error("This test has no questions yet. Please check the sheet data.");
        return;
      }
      setSelectedTest(fullTest);
      setView("instructions");
    } catch (err: any) {
      toast.error("Failed to load test questions. Check server connection.");
    } finally {
      setTestLoading(false);
    }
  };

  const beginTest = () => {
    if (!selectedTest) return;
    const questions = selectedTest.questions;
    if (!questions?.length) {
      toast.error("No questions found in this test.");
      return;
    }
    setCurrentIdx(0);
    setReviewIdx(0);
    setAnswers({});
    setFlagged(new Set());
    setEditsUsed(0);
    reachedReviewRef.current = false;
    setTimeLeft((selectedTest.durationMinutes || 45) * 60);
    setSubmitted(false);
    setResult(null);
    setReviewMode(false);
    setView("test");
  };

  const toggleFlag = useCallback(
    (qId: string) => {
      setFlagged((prev) => {
        const next = new Set(prev);
        next.has(qId) ? next.delete(qId) : next.add(qId);
        return next;
      });
    },
    []
  );

  // Answering the current question during the sequential phase — free to
  // change your mind on THIS question as many times as you like, since it
  // hasn't been "locked" (passed) yet. No edit is consumed here.
  const selectAnswer = (qId: string, val: string) => {
    setAnswers((prev) => ({ ...prev, [qId]: val }));
  };

  // Advancing past a question locks it in. Changing it later (on the Review
  // & Edit screen) will consume one of the 3 allowed edits.
  const goNext = () => {
    if (!selectedTest) return;
    const questions = selectedTest.questions;
    const currentQ = questions[currentIdx];
    if (!answers[currentQ.id]) {
      toast.error("You must select an answer before moving to the next question.");
      return;
    }
    if (currentIdx < questions.length - 1) {
      setCurrentIdx((i) => i + 1);
    } else {
      // Final question answered in time — go to Question Review & Edit.
      reachedReviewRef.current = true;
      setReviewIdx(0);
      setView("reviewEdit");
    }
  };

  // Changing an answer on the Review & Edit screen. Only counts as an edit
  // if the value actually changes; capped at MAX_EDITS_PER_SECTION for the
  // whole section (not per question — two edits on one question use two of
  // the three edits).
  const editAnswer = (qId: string, val: string) => {
    if (answers[qId] === val) return; // re-selecting the same answer is not an edit
    if (editsUsed >= MAX_EDITS_PER_SECTION) {
      toast.error("You've used all 3 answer changes allowed for this section.");
      return;
    }
    setAnswers((prev) => ({ ...prev, [qId]: val }));
    setEditsUsed((e) => e + 1);
  };

  const handleSubmit = useCallback(async () => {
    if (!selectedTest || submitted) return;

    setSubmitted(true);

    let correct = 0,
      wrong = 0,
      skipped = 0;

    selectedTest.questions.forEach((q) => {
      const ans = answers[q.id];
      if (!ans) {
        skipped++;
      } else if (ans === q.correctAnswer) {
        correct++;
      } else {
        wrong++;
      }
    });

    const total = selectedTest.questions.length;
    const scaledScore = calcScaledScore(correct, total);
    const totalScore = Math.round((correct / total) * 100);
    const timeSpent = selectedTest.durationMinutes * 60 - timeLeft;

    const payload: SectionalResult = {
      testId: selectedTest.id,
      section: selectedTest.section,
      totalScore,
      correctAnswers: correct,
      wrongAnswers: wrong,
      skippedQuestions: skipped,
      timeSpent,
      studentAnswers: answers,
      scaledScore,
      editsUsed,
      reachedReview: reachedReviewRef.current,
    };

    try {
      await apiRequest("/sectional-results", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setResult(payload);
      setAttempts((prev) => ({ ...prev, [selectedTest.id]: payload }));
      setView("result");
      toast.success("Section submitted!");
    } catch (err: any) {
      toast.error("Failed to save result");
      setResult(payload);
      setView("result");
    }
  }, [selectedTest, submitted, answers, timeLeft, editsUsed]);

  // ─── VIEWS ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // ── LIST ────────────────────────────────────────────────────────────────────
  if (view === "list") {
    const grouped = SECTION_ORDER.reduce((acc, sec) => {
      acc[sec] = availableTests.filter((t) => t.section === sec);
      return acc;
    }, {} as Record<GmatSection, SectionalTest[]>);

    return (
      <div className="space-y-8">
        <header>
          <h1 className="text-3xl font-bold tracking-tight">GMAT Sectional Tests</h1>
          <p className="text-muted-foreground mt-1">
            GMAT Focus Edition section-wise mocks · 45 min · Real exam interface
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {SECTION_ORDER.map((sec) => {
            const meta = SECTION_META[sec];
            return (
              <div
                key={sec}
                className={`rounded-xl p-4 border ${meta.lightColor} ${meta.borderColor}`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-2 h-2 rounded-full ${meta.color}`} />
                  <span className={`text-xs font-bold uppercase tracking-wider ${meta.textColor}`}>
                    {meta.short}
                  </span>
                </div>
                <p className="font-semibold text-sm">{meta.label}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {meta.questions} Qs · {meta.minutes} min
                </p>
              </div>
            );
          })}
        </div>

        {availableTests.length === 0 ? (
          <div className="py-20 flex flex-col items-center justify-center text-center border border-dashed rounded-2xl bg-background">
            <BookOpen className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <h3 className="font-bold text-lg">No Sectional Tests Available</h3>
            <p className="text-muted-foreground max-w-sm mt-1">
              Your admin hasn't published any sectional tests yet. Check back soon.
            </p>
          </div>
        ) : (
          <div className="space-y-8">
            {SECTION_ORDER.map((sec) => {
              const tests = grouped[sec];
              if (!tests?.length) return null;
              const meta = SECTION_META[sec];
              return (
                <div key={sec}>
                  <div className="flex items-center gap-3 mb-4">
                    <div className={`w-3 h-3 rounded-full ${meta.color}`} />
                    <h2 className="font-bold text-lg">{meta.label}</h2>
                    <Badge variant="secondary">{tests.length} tests</Badge>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {tests.map((t) => {
                      const attempted = attempts[t.id];
                      return (
                        <Card
                          key={t.id}
                          className={`hover:shadow-md transition-all border-t-4 ${meta.color.replace("bg-", "border-t-")}`}
                        >
                          <CardHeader className="pb-2">
                            <div className="flex justify-between items-start">
                              <Badge
                                variant="outline"
                                className={`${meta.lightColor} ${meta.textColor} ${meta.borderColor} text-[10px] font-bold`}
                              >
                                {meta.short}
                              </Badge>
                              {attempted ? (
                                <Badge className="bg-green-100 text-green-700 hover:bg-green-100 border-none text-[10px]">
                                  Completed
                                </Badge>
                              ) : (
                                <Badge variant="secondary" className="text-[10px]">
                                  Pending
                                </Badge>
                              )}
                            </div>
                            <CardTitle className="text-base mt-2">{t.name}</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            <div className="flex gap-4 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Clock size={12} /> {t.durationMinutes} min
                              </span>
                              <span className="flex items-center gap-1">
                                <BookOpen size={12} /> {t.questions?.length ?? "–"} Qs
                              </span>
                            </div>
                            {attempted && (
                              <div className={`p-3 rounded-xl ${meta.lightColor} border ${meta.borderColor}`}>
                                <div className="flex gap-4 text-center">
                                  <div className="flex-1">
                                    <p className="text-[10px] font-bold uppercase text-muted-foreground">Score</p>
                                    <p className={`text-xl font-black ${meta.textColor}`}>
                                      {attempted.scaledScore}
                                    </p>
                                  </div>
                                  <div className="w-px bg-border" />
                                  <div className="flex-1">
                                    <p className="text-[10px] font-bold uppercase text-muted-foreground">Correct</p>
                                    <p className="text-xl font-black text-green-600">
                                      {attempted.correctAnswers}
                                    </p>
                                  </div>
                                  <div className="w-px bg-border" />
                                  <div className="flex-1">
                                    <p className="text-[10px] font-bold uppercase text-muted-foreground">Acc.</p>
                                    <p className="text-xl font-black">
                                      {attempted.totalScore}%
                                    </p>
                                  </div>
                                </div>
                              </div>
                            )}
                            <Button
                              className="w-full"
                              variant={attempted ? "outline" : "default"}
                              onClick={() => startTest(t)}
                              disabled={testLoading}
                            >
                              {testLoading && selectedTest?.id === t.id
                                ? "Loading..."
                                : attempted ? "Review Attempt" : "Start Section"}
                            </Button>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── INSTRUCTIONS ─────────────────────────────────────────────────────────────
  if (view === "instructions" && selectedTest) {
    const meta = SECTION_META[selectedTest.section];
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Button variant="ghost" className="gap-2" onClick={() => setView("list")}>
          <ArrowLeft size={16} /> Back
        </Button>
        <Card className={`border-2 ${meta.borderColor}`}>
          <CardHeader className={`${meta.lightColor} rounded-t-xl`}>
            <div className={`text-xs font-bold uppercase tracking-widest ${meta.textColor} mb-1`}>
              {meta.short}
            </div>
            <CardTitle className="text-2xl">{selectedTest.name}</CardTitle>
          </CardHeader>
          <CardContent className="pt-6 space-y-6">
            <div className="grid grid-cols-3 gap-4 text-center">
              {[
                ["Questions", selectedTest.questions?.length],
                ["Duration", `${selectedTest.durationMinutes} min`],
                ["Marking", "No penalty"],
              ].map(([label, val]) => (
                <div key={label} className="p-4 bg-secondary/30 rounded-xl">
                  <p className="text-2xl font-black">{val}</p>
                  <p className="text-xs text-muted-foreground font-bold uppercase mt-1">{label}</p>
                </div>
              ))}
            </div>

            <div className="space-y-3">
              <h3 className="font-bold text-sm uppercase tracking-wide text-muted-foreground">Instructions</h3>
              {[
                "This is a timed section test. The timer starts the moment you click Begin, and keeps running through the review screen described below.",
                "Questions appear one at a time and you cannot skip ahead. You must select an answer before the Next button unlocks.",
                "There is no negative marking — an incorrect answer costs you nothing beyond the question itself. But an unanswered question is not allowed; you cannot leave one blank to look at a later question.",
                "While moving forward, you can bookmark (flag) any question, as many as you like, to find it quickly later.",
                "If you answer the final question with time still on the clock, you'll reach the Question Review & Edit screen. There you can open any question in the section — but you may change at most 3 answers in total for the whole section (changing the same question twice counts as two of your three edits).",
                "If the timer hits zero before you finish answering every question, the section submits immediately with whatever you've answered so far, and the Review & Edit screen will not appear.",
                "Once you submit the section — manually or because time ran out — your answers are final and cannot be changed.",
              ].map((rule, i) => (
                <div key={i} className="flex gap-3 text-sm">
                  <span className={`w-5 h-5 shrink-0 rounded-full ${meta.color} text-white flex items-center justify-center text-[10px] font-bold mt-0.5`}>
                    {i + 1}
                  </span>
                  <p className="text-muted-foreground">{rule}</p>
                </div>
              ))}
            </div>

            <Button size="lg" className="w-full" onClick={beginTest}>
              Begin Section · {selectedTest.durationMinutes} min
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── SEQUENTIAL TEST VIEW (one question, no skipping, no going back) ─────────
  if (view === "test" && selectedTest) {
    const questions = selectedTest.questions || [];
    if (!questions.length) {
      return (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <p className="text-muted-foreground">No questions found in this test.</p>
          <Button onClick={() => setView("list")}>Back to Tests</Button>
        </div>
      );
    }
    const currentQ = questions[currentIdx];
    if (!currentQ) return null;
    const meta = SECTION_META[selectedTest.section];
    const answeredCount = Object.keys(answers).length;
    const progress = (answeredCount / questions.length) * 100;
    const isLast = currentIdx === questions.length - 1;
    const isAnswered = !!answers[currentQ.id];

    return (
      <div className="flex flex-col h-full min-h-screen">
        {/* Sticky Header */}
        <div className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b shadow-sm">
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Badge className={`${meta.color} text-white border-none`}>{meta.short}</Badge>
              <span className="text-sm font-medium hidden sm:block truncate max-w-[200px]">
                {selectedTest.name}
              </span>
            </div>
            <div className="flex items-center gap-4">
              <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground">
                <span className="font-bold text-foreground">{currentIdx + 1}</span> / {questions.length}
              </div>
              <div
                className={`flex items-center gap-2 font-mono font-bold text-sm px-3 py-1.5 rounded-lg ${
                  timeLeft < 300
                    ? "bg-red-100 text-red-600 animate-pulse"
                    : "bg-secondary text-foreground"
                }`}
              >
                <Clock size={14} />
                {formatTime(timeLeft)}
              </div>
            </div>
          </div>
          <Progress value={progress} className="h-1 rounded-none" />
        </div>

        {/* Single-question column — no palette, no jumping around */}
        <div className="flex-1 max-w-3xl mx-auto w-full px-4 py-6 space-y-4">
          {activePassage && (
            <Card className="border-l-4 border-l-violet-400">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase text-muted-foreground tracking-wide">
                    {selectedTest.section === "DataInsights" ? "Stimulus" : "Reading Passage"} · {activePassage.title}
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-sm leading-relaxed text-muted-foreground max-h-56 overflow-y-auto pr-2">
                  <PassageContent text={activePassage.text} />
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="shadow-md">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded ${meta.lightColor} ${meta.textColor}`}>
                    Q {currentIdx + 1} / {questions.length}
                  </span>
                  {!isAnswered && (
                    <span className="text-[10px] font-bold text-orange-500 flex items-center gap-1">
                      <AlertCircle size={12} /> Select an answer to continue
                    </span>
                  )}
                </div>
                <button
                  onClick={() => toggleFlag(currentQ.id)}
                  className={`p-1.5 rounded-lg transition-colors ${
                    flagged.has(currentQ.id)
                      ? "text-orange-500 bg-orange-50"
                      : "text-muted-foreground hover:bg-secondary"
                  }`}
                  title="Bookmark for review"
                >
                  <Flag size={16} fill={flagged.has(currentQ.id) ? "currentColor" : "none"} />
                </button>
              </div>
              <p className="text-base font-semibold leading-relaxed mt-3">
                <MultiParagraphLatex text={currentQ.questionText} />
              </p>
            </CardHeader>
            <CardContent className="space-y-2">
              <RadioGroup
                value={answers[currentQ.id] || ""}
                onValueChange={(val) => selectAnswer(currentQ.id, val)}
              >
                {(Array.isArray(currentQ.options) ? currentQ.options : []).filter(Boolean).map((opt, idx) => (
                  <Label
                    key={opt}
                    className={`flex items-center gap-3 p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
                      answers[currentQ.id] === opt
                        ? `border-primary bg-blue-50 ring-1 ring-primary`
                        : "border-border hover:border-primary/30 hover:bg-secondary/30"
                    }`}
                  >
                    <RadioGroupItem value={opt} id={`opt-${idx}`} className="sr-only" />
                    <div
                      className={`w-7 h-7 shrink-0 rounded-lg flex items-center justify-center font-bold text-xs border ${
                        answers[currentQ.id] === opt
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-secondary text-muted-foreground border-border"
                      }`}
                    >
                      {String.fromCharCode(65 + idx)}
                    </div>
                    <span className="text-sm"><Latex>{opt}</Latex></span>
                  </Label>
                ))}
              </RadioGroup>
            </CardContent>
          </Card>

          {/* Forward-only navigation — no Previous, no Clear (can't leave blank) */}
          <div className="flex justify-end items-center">
            <Button
              onClick={goNext}
              disabled={!isAnswered}
              className="gap-1"
              size="lg"
            >
              {isLast ? (
                <>Answer & Continue to Review <ChevronRight size={16} /></>
              ) : (
                <>Next Question <ChevronRight size={16} /></>
              )}
            </Button>
          </div>
          <p className="text-center text-xs text-muted-foreground">
            You can bookmark this question, but you cannot skip it or come back to it until the Review & Edit screen.
          </p>
        </div>
      </div>
    );
  }

  // ── QUESTION REVIEW & EDIT VIEW (post-final-question, pre-submission) ───────
  if (view === "reviewEdit" && selectedTest) {
    const questions = selectedTest.questions;
    const meta = SECTION_META[selectedTest.section];
    const reviewQ = questions[reviewIdx];
    if (!reviewQ) return null;
    const editsLeft = MAX_EDITS_PER_SECTION - editsUsed;
    const answeredCount = Object.keys(answers).length;

    return (
      <div className="flex flex-col h-full min-h-screen">
        <div className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b shadow-sm">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Badge className={`${meta.color} text-white border-none`}>{meta.short}</Badge>
              <span className="text-sm font-bold flex items-center gap-1">
                <ListChecks size={14} /> Question Review &amp; Edit
              </span>
            </div>
            <div className="flex items-center gap-4">
              <div
                className={`hidden sm:flex items-center gap-2 text-xs font-bold px-2.5 py-1 rounded-lg ${
                  editsLeft === 0
                    ? "bg-red-100 text-red-600"
                    : "bg-secondary text-foreground"
                }`}
              >
                {editsLeft === 0 ? <Lock size={12} /> : null}
                {editsLeft} of {MAX_EDITS_PER_SECTION} edits left
              </div>
              <div
                className={`flex items-center gap-2 font-mono font-bold text-sm px-3 py-1.5 rounded-lg ${
                  timeLeft < 300
                    ? "bg-red-100 text-red-600 animate-pulse"
                    : "bg-secondary text-foreground"
                }`}
              >
                <Clock size={14} />
                {formatTime(timeLeft)}
              </div>
              <Button size="sm" variant="destructive" onClick={handleSubmit}>
                Submit Section
              </Button>
            </div>
          </div>
        </div>

        <div className="flex-1 max-w-6xl mx-auto w-full px-4 py-6 grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-6">
          {/* Left: viewable/editable question */}
          <div className="space-y-4">
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800">
              You can open any question below. Selecting a different answer than the one you originally locked in uses one of your <strong>{MAX_EDITS_PER_SECTION} edits</strong> for this section — viewing a question never does.
            </div>

            {activePassage && (
              <Card className="border-l-4 border-l-violet-400">
                <CardHeader className="pb-2">
                  <span className="text-xs font-bold uppercase text-muted-foreground tracking-wide">
                    {selectedTest.section === "DataInsights" ? "Stimulus" : "Reading Passage"} · {activePassage.title}
                  </span>
                </CardHeader>
                <CardContent>
                  <div className="text-sm leading-relaxed text-muted-foreground max-h-56 overflow-y-auto pr-2">
                    <PassageContent text={activePassage.text} />
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="shadow-md">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <span className={`text-xs font-bold px-2 py-0.5 rounded ${meta.lightColor} ${meta.textColor}`}>
                    Q {reviewIdx + 1} / {questions.length}
                  </span>
                  <button
                    onClick={() => toggleFlag(reviewQ.id)}
                    className={`p-1.5 rounded-lg transition-colors ${
                      flagged.has(reviewQ.id)
                        ? "text-orange-500 bg-orange-50"
                        : "text-muted-foreground hover:bg-secondary"
                    }`}
                    title="Bookmark"
                  >
                    <Flag size={16} fill={flagged.has(reviewQ.id) ? "currentColor" : "none"} />
                  </button>
                </div>
                <p className="text-base font-semibold leading-relaxed mt-3">
                  <MultiParagraphLatex text={reviewQ.questionText} />
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                <RadioGroup
                  value={answers[reviewQ.id] || ""}
                  onValueChange={(val) => editAnswer(reviewQ.id, val)}
                >
                  {(Array.isArray(reviewQ.options) ? reviewQ.options : []).filter(Boolean).map((opt, idx) => {
                    const isSelected = answers[reviewQ.id] === opt;
                    const blockedByEditCap = editsLeft === 0 && !isSelected;
                    return (
                      <Label
                        key={opt}
                        className={`flex items-center gap-3 p-3.5 rounded-xl border-2 transition-all ${
                          blockedByEditCap ? "cursor-not-allowed opacity-50" : "cursor-pointer"
                        } ${
                          isSelected
                            ? "border-primary bg-blue-50 ring-1 ring-primary"
                            : "border-border hover:border-primary/30 hover:bg-secondary/30"
                        }`}
                      >
                        <RadioGroupItem
                          value={opt}
                          id={`ropt-${idx}`}
                          className="sr-only"
                          disabled={blockedByEditCap}
                        />
                        <div
                          className={`w-7 h-7 shrink-0 rounded-lg flex items-center justify-center font-bold text-xs border ${
                            isSelected
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-secondary text-muted-foreground border-border"
                          }`}
                        >
                          {String.fromCharCode(65 + idx)}
                        </div>
                        <span className="text-sm"><Latex>{opt}</Latex></span>
                      </Label>
                    );
                  })}
                </RadioGroup>
                {editsLeft === 0 && (
                  <p className="text-xs text-red-600 flex items-center gap-1 mt-2">
                    <Lock size={12} /> You've used all {MAX_EDITS_PER_SECTION} answer changes for this section — this question's answer is now locked.
                  </p>
                )}
              </CardContent>
            </Card>

            <div className="flex justify-between items-center">
              <Button
                variant="outline"
                onClick={() => setReviewIdx((i) => Math.max(0, i - 1))}
                disabled={reviewIdx === 0}
                className="gap-1"
              >
                <ChevronLeft size={16} /> Previous
              </Button>
              {reviewIdx < questions.length - 1 ? (
                <Button
                  variant="outline"
                  onClick={() => setReviewIdx((i) => Math.min(questions.length - 1, i + 1))}
                  className="gap-1"
                >
                  Next <ChevronRight size={16} />
                </Button>
              ) : (
                <Button variant="destructive" onClick={handleSubmit}>
                  Submit Section
                </Button>
              )}
            </div>
          </div>

          {/* Right: full palette — free navigation, no restriction */}
          <div className="lg:sticky lg:top-[88px] self-start space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">All Questions</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-5 gap-1.5 mb-4">
                  {questions.map((q, idx) => (
                    <StatusDot
                      key={q.id}
                      idx={idx}
                      answered={!!answers[q.id]}
                      flagged={flagged.has(q.id)}
                      current={idx === reviewIdx}
                      onClick={() => setReviewIdx(idx)}
                    />
                  ))}
                </div>
                <div className="space-y-1.5 text-xs text-muted-foreground border-t pt-3">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded bg-blue-500" />
                    Answered ({answeredCount})
                  </div>
                  <div className="flex items-center gap-2 relative">
                    <div className="w-4 h-4 rounded bg-secondary border relative">
                      <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-orange-400 rounded-full" />
                    </div>
                    Bookmarked ({flagged.size})
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className={`border ${meta.borderColor}`}>
              <CardContent className="pt-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Edits remaining</span>
                  <span className={`font-bold ${editsLeft === 0 ? "text-red-600" : meta.textColor}`}>
                    {editsLeft} / {MAX_EDITS_PER_SECTION}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Bookmarked</span>
                  <span className="font-bold text-orange-500">{flagged.size}</span>
                </div>
              </CardContent>
            </Card>

            <Button className="w-full gap-2" size="lg" variant="destructive" onClick={handleSubmit}>
              Submit Section
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── RESULT VIEW ───────────────────────────────────────────────────────────────
  if (view === "result" && result && selectedTest) {
    const meta = SECTION_META[selectedTest.section as GmatSection];
    const questions = selectedTest.questions;

    if (reviewMode) {
      return (
        <div className="max-w-4xl mx-auto space-y-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={() => setReviewMode(false)} className="gap-1">
              <ArrowLeft size={16} /> Back to Results
            </Button>
            <span className="font-bold">{selectedTest.name} · Review</span>
          </div>
          <div className="space-y-4">
            {questions.map((q, idx) => {
              const studentAns = result.studentAnswers[q.id];
              const isCorrect = studentAns === q.correctAnswer;
              const isSkipped = !studentAns;
              const passage = q.passageId && selectedTest.passages
                ? selectedTest.passages.find((p) => p.id === q.passageId)
                : null;
              return (
                <Card
                  key={q.id}
                  className={`border-l-4 ${
                    isCorrect
                      ? "border-l-green-500"
                      : isSkipped
                      ? "border-l-yellow-400"
                      : "border-l-red-500"
                  }`}
                >
                  <CardHeader className="pb-2">
                    <div className="flex justify-between items-center">
                      <div className="flex gap-2">
                        <Badge variant="outline">{SECTION_META[q.section]?.short ?? q.section}</Badge>
                        <Badge variant="outline" className="text-[10px]">{q.difficulty}</Badge>
                      </div>
                      {isCorrect ? (
                        <span className="text-green-600 flex items-center gap-1 text-xs font-bold">
                          <CheckCircle2 size={14} /> Correct
                        </span>
                      ) : isSkipped ? (
                        <span className="text-yellow-600 flex items-center gap-1 text-xs font-bold">
                          <AlertCircle size={14} /> Skipped
                        </span>
                      ) : (
                        <span className="text-red-600 flex items-center gap-1 text-xs font-bold">
                          <XCircle size={14} /> Incorrect
                        </span>
                      )}
                    </div>
                    <p className="font-semibold text-sm mt-2">
                      <span>Q{idx + 1}. </span>
                      <MultiParagraphLatex text={q.questionText} />
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="grid gap-1.5">
                      {q.options.map((opt) => (
                        <div
                          key={opt}
                          className={`px-3 py-2 rounded-lg text-sm border ${
                            opt === q.correctAnswer
                              ? "bg-green-50 border-green-200 text-green-800 font-medium"
                              : opt === studentAns
                              ? "bg-red-50 border-red-200 text-red-800"
                              : "bg-secondary/20 border-transparent"
                          }`}
                        >
                          <Latex> {opt}</Latex>
                        </div>
                      ))}
                    </div>
                    {q.explanation && (
                      <div className="bg-secondary/30 p-3 rounded-lg text-sm">
                        <p className="font-bold text-xs uppercase mb-1">Explanation</p>
                        <div className="text-muted-foreground">
                          <MultiParagraphLatex text={q.explanation} />
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      );
    }

    const attemptRate = Math.round(((result.correctAnswers + result.wrongAnswers) / questions.length) * 100);

    return (
      <div className="max-w-3xl mx-auto space-y-8">
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={() => setView("list")} className="gap-1">
            <ArrowLeft size={16} /> All Tests
          </Button>
        </div>

        <Card className={`border-2 ${meta.borderColor} overflow-hidden`}>
          <div className={`${meta.color} px-6 py-5 text-white`}>
            <p className="text-sm font-bold uppercase tracking-widest opacity-80">{meta.label}</p>
            <h2 className="text-2xl font-black mt-1">{selectedTest.name}</h2>
          </div>
          <CardContent className="pt-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
              {[
                { label: "Scaled Score", val: `${result.scaledScore}`, color: meta.textColor, big: true },
                { label: "Correct / Total", val: `${result.correctAnswers}/${questions.length}`, color: "text-foreground" },
                { label: "Accuracy", val: `${result.totalScore}%`, color: "text-foreground" },
                {
                  label: "Time Taken",
                  val: `${Math.floor(result.timeSpent / 60)}m ${result.timeSpent % 60}s`,
                  color: "text-foreground",
                },
              ].map(({ label, val, color, big }) => (
                <div key={label} className="p-4 bg-secondary/20 rounded-xl">
                  <p className="text-xs font-bold uppercase text-muted-foreground mb-1">{label}</p>
                  <p className={`font-black ${big ? "text-4xl" : "text-2xl"} ${color}`}>{val}</p>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground text-center mt-3">
              Scaled score (60–90) is a practice-test approximation based on accuracy, since GMAC's real adaptive scoring algorithm isn't public.
            </p>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="p-5 text-center border-t-4 border-t-green-500">
            <CheckCircle2 className="mx-auto text-green-500 mb-2" size={24} />
            <p className="text-3xl font-black text-green-600">{result.correctAnswers}</p>
            <p className="text-xs font-bold uppercase text-muted-foreground mt-1">Correct</p>
          </Card>
          <Card className="p-5 text-center border-t-4 border-t-red-500">
            <XCircle className="mx-auto text-red-500 mb-2" size={24} />
            <p className="text-3xl font-black text-red-600">{result.wrongAnswers}</p>
            <p className="text-xs font-bold uppercase text-muted-foreground mt-1">Incorrect</p>
            <p className="text-xs text-muted-foreground font-semibold mt-1">No penalty</p>
          </Card>
          <Card className="p-5 text-center border-t-4 border-t-yellow-400">
            <AlertCircle className="mx-auto text-yellow-500 mb-2" size={24} />
            <p className="text-3xl font-black text-yellow-600">{result.skippedQuestions}</p>
            <p className="text-xs font-bold uppercase text-muted-foreground mt-1">Skipped</p>
          </Card>
        </div>

        <Card className="p-5">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-bold">Attempt Rate</span>
            <span className="text-sm font-bold">{attemptRate}%</span>
          </div>
          <Progress value={attemptRate} className="h-2" />
          <p className="text-xs text-muted-foreground mt-2">
            You attempted {result.correctAnswers + result.wrongAnswers} of {questions.length} questions.
            {typeof result.editsUsed === "number" && (
              <> Used {result.editsUsed} of {MAX_EDITS_PER_SECTION} answer edits.</>
            )}
            {result.reachedReview === false && (
              <> The Review &amp; Edit screen was not reached because time ran out first.</>
            )}
          </p>
        </Card>

        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1 gap-2"
            onClick={() => setReviewMode(true)}
          >
            <Eye size={16} /> Review All Questions
          </Button>
          <Button className="flex-1 gap-2" onClick={() => setView("list")}>
            <BarChart3 size={16} /> Back to Tests
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
