export const CHAT_WELCOME = "Hello, I can help with your portfolio analysis today.";

export const makeChatSessionId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const getInitialChatSessionId = () => {
  const fallback = makeChatSessionId();
  if (typeof window === "undefined") return fallback;
  try {
    const existing = window.localStorage.getItem("chatSessionId");
    if (existing) return existing;
    window.localStorage.setItem("chatSessionId", fallback);
    return fallback;
  } catch {
    return fallback;
  }
};

export const makeInitialChatMessage = (t) => ({
  role: "assistant",
  content: t(CHAT_WELCOME),
});

const escapeHtml = (value = "") =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const renderInlineMarkdown = (text = "") => {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    .replace(/\[(.+?)\]\((https?:[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
};

export const renderMarkdown = (value = "") => {
  if (!value) return "";
  const lines = value.split(/\r?\n/);
  let html = "";
  let inCode = false;
  let codeBuffer = [];
  let listBuffer = [];

  const splitTableRow = (row) => {
    let trimmed = row.trim();
    if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
    if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
    return trimmed.split("|").map((cell) => cell.trim());
  };

  const isSeparatorRow = (row) =>
    /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(row);

  const flushCode = () => {
    if (!codeBuffer.length) return;
    html += `<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`;
    codeBuffer = [];
  };

  const flushList = () => {
    if (!listBuffer.length) return;
    html += `<ul>${listBuffer.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`;
    listBuffer = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushList();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      flushList();
      const headerCells = splitTableRow(line);
      const bodyRows = [];
      i += 2;
      while (i < lines.length) {
        const rowLine = lines[i];
        const rowTrimmed = rowLine.trim();
        if (!rowTrimmed || rowTrimmed.startsWith("```") || !rowLine.includes("|")) {
          i -= 1;
          break;
        }
        bodyRows.push(splitTableRow(rowLine));
        i += 1;
      }
      const headerHtml = headerCells
        .map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`)
        .join("");
      const bodyHtml = bodyRows
        .map((row) => {
          const cells = headerCells.map((_, idx) => row[idx] ?? "");
          return `<tr>${cells
            .map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`)
            .join("")}</tr>`;
        })
        .join("");
      html += `<table class="chat-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
      continue;
    }

    const listMatch = line.match(/^\s*[-*]\s+(.*)/);
    if (listMatch) {
      listBuffer.push(listMatch[1]);
      continue;
    }

    flushList();

    if (!trimmed) {
      html += "<br />";
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length);
      html += `<p class="chat-heading h${level}">${renderInlineMarkdown(headingMatch[2])}</p>`;
      continue;
    }

    html += `<p>${renderInlineMarkdown(line)}</p>`;
  }

  if (inCode) {
    flushCode();
    inCode = false;
  }
  flushList();
  return html;
};
