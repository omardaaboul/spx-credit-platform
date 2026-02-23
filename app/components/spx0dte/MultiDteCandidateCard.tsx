"use client";

import type { CandidateCard as CandidateCardType } from "@/lib/spx0dte";
import CandidateDecisionCard from "@/app/components/spx0dte/CandidateCard";

type MultiDteCandidateCardProps = {
  candidate: CandidateCardType;
  onOpenChecklist: () => void;
  onOpenDetails?: () => void;
  onCopyOrderTicket?: () => void;
  onOpenPayoff?: () => void;
  onPlaceTrade: () => void;
  dataQualityPass: boolean;
  greeksData?: {
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
    iv?: number;
  };
  placing?: boolean;
  placeDisabled?: boolean;
  copyState?: "idle" | "ok" | "error";
  paperState?: "idle" | "sending" | "ok" | "error";
  paperMessage?: string;
};

export default function MultiDteCandidateCard({
  candidate,
  onOpenChecklist,
  onOpenDetails,
  onCopyOrderTicket,
  onOpenPayoff,
  onPlaceTrade,
  dataQualityPass,
  greeksData,
  placing = false,
  placeDisabled = false,
  copyState = "idle",
  paperState = "idle",
  paperMessage,
}: MultiDteCandidateCardProps) {
  return (
    <CandidateDecisionCard
      candidate={candidate}
      blocked={!candidate.ready}
      blockedReason={candidate.reason}
      riskImpactText="Checklist strict mode"
      capacityText="Live data + checklist gating active."
      onOpenChecklist={onOpenChecklist}
      onOpenDetails={onOpenDetails ?? onOpenChecklist}
      onCopyOrderTicket={onCopyOrderTicket ?? (() => undefined)}
      onOpenPayoff={onOpenPayoff ?? (() => undefined)}
      onPlacePaperTrade={onPlaceTrade}
      placeDisabled={placeDisabled || !dataQualityPass}
      placing={placing}
      copyState={copyState}
      paperState={paperState}
      paperMessage={paperMessage}
      dataQualityPass={dataQualityPass}
      greeksData={greeksData}
    />
  );
}
