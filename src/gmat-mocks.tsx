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
  Lock,
  ListChecks,
  Play,
  RotateCcw,
  Coffee,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { apiRequest } from "@/src/lib/api";

// Reuse Core Data Types from Sectional Test
type GmatSection = "Quant" | "Verbal" | "DataInsights";

interface SectionalQuestion {
  id: string;
  section: GmatSection;
  questionType: string;
  questionText: string;
  difficulty: "Easy" | "Medium" | "Hard";
  passageId?: string;
  options?: string[];
  correctAnswer?: string;
  statements?: any[];
  blanks?: any[];
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
  passages?: any[];
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

const MAX_EDITS_PER_SECTION = 3;

const SECTION_META: Record<GmatSection, { label: string; short: string; color: string; questions: number; minutes: number }> = {
  Quant: { label: "Quantitative Reasoning", short: "Quant", color: "bg-emerald-500", questions: 21, minutes: 45 },
  Verbal: { label: "Verbal Reasoning", short: "Verbal", color: "bg-violet-500", questions: 23, minutes: 45 },
  DataInsights: { label: "Data Insights", short: "DI", color: "bg-blue-500", questions: 20, minutes: 45 },
};

// GMAT Focus Total Score Algorithm (205 - 805 Range)
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

export default function gmatMockTests({ user }: { user: any }) {
  const [view, setView] = useState<"list" | "orderSelect" | "testing" | "sectionReview" | "break" | "result">("list");
  const [availableMocks, setAvailableMocks] = useState<FullMockTest[]>([]);
  const [selectedMock, setSelectedMock] = useState<FullMockTest | null>(null);
  const [mockResults, setMockResults] = useState<Record<string, FullMockResult>>({});
  const [loading, setLoading] = useState(true);

  // Workflow sequence state
  const [sectionOrder, setSectionOrder] = useState<GmatSection[]>(["Quant", "Verbal", "DataInsights"]);
  const [currentSectionIdx, setCurrentSectionIdx] = useState(0);
  const [breakTimeLeft, setBreakTimeLeft] = useState(600); // 10 minutes optional break
  const [breakTaken, setBreakTaken] = useState(false);

  // Section Test Runtime State
  const [currentQIdx, setCurrentQIdx] = useState(0);
  const [sectionAnswers, setSectionAnswers] = useState<AnswersMap>({});
  const [flaggedQs, setFlaggedQs] = useState<Set<string>>(new Set());
  const [editedQs, setEditedQs] = useState<Set<string>>(new Set());
  const [sectionTimeLeft, setSectionTimeLeft] = useState(45 * 60);
  const [completedSectionResults, setCompletedSectionResults] = useState<Partial<Record<GmatSection, SectionResult>>>({});

  const activeSectionType = sectionOrder[currentSectionIdx];
  
  const currentSectionData = useMemo(() => {
    if (!selectedMock || !activeSectionType) return null;
    if (activeSectionType === "Quant") return selectedMock.quantSection;
    if (activeSectionType === "Verbal") return selectedMock.verbalSection;
    return selectedMock.dataInsightsSection;
  }, [selectedMock, activeSectionType]);

  // Fetch Mocks
  useEffect(() => {
    async function loadData() {
      try {
        const [mocks, results] = await Promise.all([
          apiRequest("/full-gmat-mocks"),
          apiRequest("/full-gmat-results"),
        ]);
        setAvailableMocks(mocks || []);
        const resMap: Record<string, FullMockResult> = {};
        (results || []).forEach((r: FullMockResult) => (resMap[r.mockId] = r));
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
    if ((view !== "testing" && view !== "sectionReview") || sectionTimeLeft <= 0) return;
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
    if ((view === "testing" || view === "sectionReview") && sectionTimeLeft === 0) {
      toast.warning("Section time expired! Submitting section...");
      completeCurrentSection();
    }
  }, [sectionTimeLeft]);

  const handleStartMockConfig = (mock: FullMockTest) => {
    setSelectedMock(mock);
    setSectionOrder(["Quant", "Verbal", "DataInsights"]);
    setView("orderSelect");
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
    setEditedQs(new Set());
    setSectionTimeLeft((secData?.durationMinutes || 45) * 60);
    setView("testing");
  };

  const completeCurrentSection = () => {
    if (!currentSectionData) return;

    let correct = 0, wrong = 0, skipped = 0;
    currentSectionData.questions.forEach((q) => {
      const ans = sectionAnswers[q.id];
      if (!ans || (ans.kind === "single" && !ans.value)) {
        skipped++;
      } else if (ans.kind === "single" && ans.value === q.correctAnswer) {
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

    const fullResultPayload: FullMockResult = {
      mockId: selectedMock.id,
      totalScaledScore,
      sectionOrder,
      sectionResults: finalSecResults as Record<GmatSection, SectionResult>,
      totalTimeSpent,
      completedAt: new Date().toISOString(),
    };

    try {
      await apiRequest("/full-gmat-results", { method: "POST", body: JSON.stringify(fullResultPayload) });
      setMockResults((prev) => ({ ...prev, [selectedMock.id]: fullResultPayload }));
      setView("result");
      toast.success("Full Mock Test Completed!");
    } catch {
      toast.error("Failed to save full exam result.");
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

                  <Button className="w-full gap-2" onClick={() => handleStartMockConfig(mock)}>
                    {completed ? <RotateCcw size={16} /> : <Play size={16} />}
                    {completed ? "Retake Mock Exam" : "Start Mock Exam"}
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

  // 4. TEST ATTEMPT & SECTION REVIEW INTERFACE
  if ((view === "testing" || view === "sectionReview") && currentSectionData) {
    const q = currentSectionData.questions[currentQIdx];
    return (
      <div className="max-w-4xl mx-auto space-y-4 py-4">
        {/* Exam Header Bar */}
        <div className="flex justify-between items-center bg-card p-4 rounded-xl border shadow-sm">
          <Badge className={SECTION_META[activeSectionType].color}>{SECTION_META[activeSectionType].label}</Badge>
          <div className="flex items-center gap-4 text-sm font-bold font-mono">
            <Clock size={16} />
            {Math.floor(sectionTimeLeft / 60)}:{(sectionTimeLeft % 60).toString().padStart(2, "0")}
          </div>
        </div>

        {/* Question View */}
        <Card>
          <CardHeader>
            <div className="flex justify-between">
              <span className="text-xs font-bold text-muted-foreground">Question {currentQIdx + 1} of {currentSectionData.questions.length}</span>
              <Button variant="ghost" size="sm" onClick={() => completeCurrentSection()}>End Section Early</Button>
            </div>
            <CardTitle className="text-base mt-2">{q?.questionText}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {q?.options?.map((opt, i) => (
              <button
                key={i}
                onClick={() => setSectionAnswers((prev) => ({ ...prev, [q.id]: { kind: "single", value: opt } }))}
                className={`w-full text-left p-3.5 rounded-xl border text-sm transition-all ${
                  sectionAnswers[q.id]?.kind === "single" && (sectionAnswers[q.id] as any).value === opt
                    ? "border-primary bg-primary/5 font-semibold"
                    : "border-border hover:bg-secondary/30"
                }`}
              >
                {opt}
              </button>
            ))}

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
