import { MonoLabel } from "@/components/ui";
import type { ThreadMessage } from "@/lib/types";

export function RequestThread({
  messages,
  viewerIsAdmin,
  memberName,
  emptyText,
  className = "",
}: {
  messages: ThreadMessage[];
  viewerIsAdmin: boolean;
  memberName: string;
  emptyText: string;
  className?: string;
}) {
  if (messages.length === 0) {
    return <span className={`text-[13px] text-muted ${className}`}>{emptyText}</span>;
  }

  return (
    <div className={`flex flex-col gap-2.5 ${className}`}>
      {messages.map((message, index) => {
        const mine = (message.by === "admin") === viewerIsAdmin;
        return (
          <div
            key={`${message.at}-${index}`}
            className={`flex max-w-[88%] flex-col gap-1 rounded-[9px] px-3 py-2.5 ${
              mine ? "self-end bg-brand-tint" : "self-start bg-line"
            }`}
          >
            <MonoLabel className="tracking-normal">
              {message.by === "admin" ? "Admin" : memberName} · {message.at}
            </MonoLabel>
            <span className="text-[13.5px] leading-relaxed text-ink">
              {message.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
