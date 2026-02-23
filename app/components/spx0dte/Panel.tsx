import type { ReactNode } from "react";

type PanelProps = {
  children: ReactNode;
  className?: string;
  as?: "section" | "article" | "div";
};

export default function Panel({ children, className = "", as = "section" }: PanelProps) {
  const Tag = as;
  return <Tag className={`panel ${className}`.trim()}>{children}</Tag>;
}
