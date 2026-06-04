import { listCapabilities } from "./graphStore.js";
import { assessPromotionReadiness } from "./promotion.js";
import type { CapabilityNode } from "./capability.js";

export type CapabilityReviewStatus = "pending" | "promoted" | "rejected" | "rotted" | "forbidden";

export interface CapabilityReviewItem {
  id: string;
  name: string;
  capabilityStatus: CapabilityNode["status"];
  reviewStatus: CapabilityReviewStatus;
  reasons: string[];
  updatedAt: string;
}

export async function capabilityReviewQueue(home: string): Promise<CapabilityReviewItem[]> {
  return (await listCapabilities(home)).map(capabilityReviewItem).sort(compareReviewItems);
}

export function capabilityReviewItem(node: CapabilityNode): CapabilityReviewItem {
  if (node.status === "mastered") {
    return {
      id: node.id,
      name: node.name,
      capabilityStatus: node.status,
      reviewStatus: "promoted",
      reasons: [
        `mastered with ${node.outcomes.ok} verified success(es)${node.skillRef ? ` and skill ${node.skillRef}` : ""}`,
      ],
      updatedAt: node.updatedAt,
    };
  }
  if (node.status === "forbidden") {
    return {
      id: node.id,
      name: node.name,
      capabilityStatus: node.status,
      reviewStatus: "forbidden",
      reasons: [node.outcomes.lastError ?? "capability is explicitly forbidden"],
      updatedAt: node.updatedAt,
    };
  }
  if (node.status === "rotted") {
    const reviewStatus = node.outcomes.ok > 0 ? "rotted" : "rejected";
    return {
      id: node.id,
      name: node.name,
      capabilityStatus: node.status,
      reviewStatus,
      reasons: [node.outcomes.lastError ?? (reviewStatus === "rotted" ? "health check failed" : "draft was rejected")],
      updatedAt: node.updatedAt,
    };
  }

  const readiness = assessPromotionReadiness(node);
  return {
    id: node.id,
    name: node.name,
    capabilityStatus: node.status,
    reviewStatus: "pending",
    reasons: readiness.reasons.length ? readiness.reasons : [`waiting for promotion review from ${node.status}`],
    updatedAt: node.updatedAt,
  };
}

export function capabilityReviewLine(item: CapabilityReviewItem): string {
  return `${item.reviewStatus} ${item.id} [${item.capabilityStatus}] ${item.name} - ${item.reasons.join("; ")}`;
}

function compareReviewItems(a: CapabilityReviewItem, b: CapabilityReviewItem): number {
  const priority = reviewPriority(a.reviewStatus) - reviewPriority(b.reviewStatus);
  if (priority !== 0) return priority;
  return b.updatedAt.localeCompare(a.updatedAt);
}

function reviewPriority(status: CapabilityReviewStatus): number {
  switch (status) {
    case "pending":
      return 0;
    case "rotted":
      return 1;
    case "rejected":
      return 2;
    case "forbidden":
      return 3;
    case "promoted":
      return 4;
  }
}
