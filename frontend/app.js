const messagesEl = document.getElementById("messages");
const welcomeEl = document.getElementById("welcome");
const chatForm = document.getElementById("chatForm");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const resetButton = document.getElementById("resetButton");

let isGenerating = false;
let currentEventSource = null;

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function scrollToBottom() {
  const chat = document.getElementById("chat");
  chat.scrollTop = chat.scrollHeight;
}

function autoResizeTextarea() {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
}

function addUserBubble(text) {
  const el = document.createElement("div");
  el.className = "message user";
  el.innerHTML = `
    <div class="bubble">${escapeHtml(text)}</div>
  `;

  messagesEl.appendChild(el);
  scrollToBottom();
}

function createAgentContainer() {
  const el = document.createElement("div");
  el.className = "message agent";
  el.innerHTML = `
    <div class="agent-content">
      <div class="status">
        <span class="dots"><span></span></span>
        <span class="status-text">Thinking...</span>
      </div>
      <div class="tool-log" style="display: none;"></div>
      <div class="text-content" style="display: none;"></div>
    </div>
  `;

  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function updateStatus(container, text) {
  const statusText = container.querySelector(".status-text");
  statusText.textContent = text;
  scrollToBottom();
}

function addToolLog(container, text) {
  const toolLog = container.querySelector(".tool-log");
  toolLog.style.display = "block";

  const item = document.createElement("div");
  item.className = "tool-log-item";
  item.textContent = text;
  toolLog.appendChild(item);

  scrollToBottom();
}

function appendAgentChunk(container, text) {
  const statusEl = container.querySelector(".status");
  const textEl = container.querySelector(".text-content");

  statusEl.style.display = "none";
  textEl.style.display = "block";

  const currentRaw = textEl.dataset.rawText || "";
  const nextRaw = currentRaw + text;

  textEl.dataset.rawText = nextRaw;
  textEl.innerHTML = renderBasicMarkdown(nextRaw);

  scrollToBottom();
}

function showError(container, message) {
  const statusEl = container.querySelector(".status");
  const textEl = container.querySelector(".text-content");
  const originalMessage = container.dataset.userMessage;

  statusEl.style.display = "none";
  textEl.style.display = "block";
  textEl.innerHTML = `
    <p class="error-text">${escapeHtml(message)}</p>
    ${originalMessage ? `<button class="retry-button" data-retry="${escapeHtml(originalMessage)}">Try again</button>` : ""}
  `;

  scrollToBottom();
}

function renderBasicMarkdown(text) {
  let html = escapeHtml(text);

  html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.*)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.*)$/gm, "<h1>$1</h1>");
  html = html.replace(/^\- (.*)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>[^]*?<\/li>)(\s*<li>[^]*?<\/li>)*/g, "<ul>$&</ul>");
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\n\n/g, "</p><p>");
  html = `<p>${html}</p>`;

  return html;
}

function setLoadingState(isLoading) {
  isGenerating = isLoading;
  sendButton.disabled = isLoading;
  messageInput.disabled = isLoading;
}

function closeCurrentStream() {
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
}

async function sendMessage(text) {
  if (!text || isGenerating) return;

  welcomeEl.style.display = "none";
  addUserBubble(text);

  messageInput.value = "";
  autoResizeTextarea();
  setLoadingState(true);

  const agentContainer = createAgentContainer();
  agentContainer.dataset.userMessage = text;

  closeCurrentStream();

  const streamUrl = `/api/chat/stream?message=${encodeURIComponent(text)}`;
  const eventSource = new EventSource(streamUrl);
  currentEventSource = eventSource;

  eventSource.addEventListener("status", (event) => {
    const data = JSON.parse(event.data);
    updateStatus(agentContainer, data.message);
  });

  eventSource.addEventListener("tool", (event) => {
    const data = JSON.parse(event.data);
    addToolLog(agentContainer, `Used tool: ${data.toolName}`);
  });

  eventSource.addEventListener("chunk", (event) => {
    const data = JSON.parse(event.data);
    appendAgentChunk(agentContainer, data.text);
  });

  eventSource.addEventListener("done", () => {
    closeCurrentStream();
    setLoadingState(false);
    messageInput.focus();
  });

  eventSource.addEventListener("error", (event) => {
    console.error("SSE error:", event);
    let message = "Streaming connection failed.";
    if (event.data) {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.message) message = parsed.message;
      } catch {
        // keep default message
      }
    }
    showError(agentContainer, message);
    closeCurrentStream();
    setLoadingState(false);
  });
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  await sendMessage(text);
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.dispatchEvent(new Event("submit"));
  }
});

messageInput.addEventListener("input", autoResizeTextarea);

document.addEventListener("click", async (event) => {
  const suggestion = event.target.closest("[data-suggestion]");
  if (suggestion) {
    await sendMessage(suggestion.textContent.trim());
    return;
  }

  const retry = event.target.closest("[data-retry]");
  if (retry) {
    await sendMessage(retry.dataset.retry);
  }
});

resetButton.addEventListener("click", async () => {
  try {
    closeCurrentStream();

    await fetch("/api/reset", {
      method: "POST",
    });

    messagesEl.innerHTML = "";
    welcomeEl.style.display = "flex";
    setLoadingState(false);
    messageInput.focus();
  } catch (error) {
    console.error("Reset error:", error);
  }
});
