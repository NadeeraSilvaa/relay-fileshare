import "./style.css";
import { httpsCallable } from "firebase/functions";
import {
  onAuthStateChanged,
  signInWithCustomToken,
  signOut,
} from "firebase/auth";
import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from "firebase/storage";
import {
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  collection,
  query,
  orderBy,
  getDocs,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore";
import { auth, storage, db, functions } from "./firebase.js";

const MAX_BYTES = 1024 * 1024 * 1024;

const EXPIRY_MS = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const loginWithUploadPassword = httpsCallable(
  functions,
  "loginWithUploadPassword"
);
const recordDownload = httpsCallable(functions, "recordDownload");

const viewLogin = document.querySelector("#view-login");
const viewApp = document.querySelector("#view-app");
const viewDownload = document.querySelector("#view-download");

const loginForm = document.querySelector("#login-form");
const passwordInput = document.querySelector("#password");
const loginSubmit = document.querySelector("#login-submit");
const loginError = document.querySelector("#login-error");
const logoutButton = document.querySelector("#logout");

const form = document.querySelector("#upload-form");
const fileInput = document.querySelector("#file");
const fileLabel = document.querySelector("#file-label");
const dropzone = document.querySelector("#dropzone");
const expirySelect = document.querySelector("#expiry");
const submitButton = document.querySelector("#submit");
const progress = document.querySelector("#progress");
const progressBar = document.querySelector("#progress-bar");
const progressText = document.querySelector("#progress-text");
const errorEl = document.querySelector("#error");
const result = document.querySelector("#result");
const shareUrl = document.querySelector("#share-url");
const copyButton = document.querySelector("#copy");
const openLink = document.querySelector("#open-link");

const historyList = document.querySelector("#history-list");
const historyEmpty = document.querySelector("#history-empty");
const refreshHistory = document.querySelector("#refresh-history");

const pathMatch = window.location.pathname.match(/^\/d\/([0-9a-fA-F-]{36})\/?$/);
const shareIdFromPath = pathMatch?.[1] ?? null;

if (shareIdFromPath) {
  showView("download");
  loadDownloadPage(shareIdFromPath);
} else {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      const token = await user.getIdTokenResult();
      if (token.claims.role === "uploader") {
        showView("app");
        await loadHistory();
        return;
      }
    }
    showView("login");
  });
}

loginForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideEl(loginError);
  const password = passwordInput.value;
  if (!password) {
    showEl(loginError, "Enter the upload password.");
    return;
  }

  loginSubmit.disabled = true;
  loginSubmit.textContent = "Signing in…";
  try {
    const { data } = await loginWithUploadPassword({ password });
    if (!data?.token) throw new Error("No token");
    await signInWithCustomToken(auth, data.token);
  } catch (error) {
    showEl(loginError, userMessage(error));
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = "Log in";
  }
});

logoutButton?.addEventListener("click", async () => {
  await signOut(auth);
  result.hidden = true;
  progress.hidden = true;
  form.reset();
  fileLabel.textContent = "Drop a file here or click — up to 1 GB";
});

fileInput?.addEventListener("change", () => {
  setFileLabel(fileInput.files[0]);
});

["dragenter", "dragover"].forEach((type) => {
  dropzone?.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((type) => {
  dropzone?.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
  });
});

dropzone?.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  setFileLabel(file);
});

copyButton?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(shareUrl.value);
    copyButton.textContent = "Copied";
    setTimeout(() => {
      copyButton.textContent = "Copy link";
    }, 1600);
  } catch {
    shareUrl.select();
  }
});

refreshHistory?.addEventListener("click", () => loadHistory());

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideError();
  result.hidden = true;

  const file = fileInput.files[0];
  const expiryKey = expirySelect.value;

  if (!auth.currentUser) {
    showError("Please log in first.");
    return;
  }
  if (!file) {
    showError("Choose a file to upload.");
    return;
  }
  if (file.size > MAX_BYTES) {
    showError("That file is larger than 1 GB.");
    return;
  }

  setBusy(true);
  showProgress(0, "Starting upload…");

  try {
    const shareId = crypto.randomUUID();
    const safeName = sanitizeFileName(file.name);
    const storagePath = `shares/${shareId}/${safeName}`;
    const storageRef = ref(storage, storagePath);
    const task = uploadBytesResumable(storageRef, file, {
      contentType: file.type || "application/octet-stream",
    });

    await new Promise((resolve, reject) => {
      task.on(
        "state_changed",
        (snapshot) => {
          const pct =
            snapshot.totalBytes === 0
              ? 0
              : (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
          showProgress(
            pct,
            `Uploading ${formatBytes(snapshot.bytesTransferred)} of ${formatBytes(snapshot.totalBytes)}`
          );
        },
        reject,
        resolve
      );
    });

    showProgress(100, "Saving link…");
    const downloadUrl = await getDownloadURL(task.snapshot.ref);
    const expiresAt = Timestamp.fromMillis(Date.now() + EXPIRY_MS[expiryKey]);

    await setDoc(doc(db, "shares", shareId), {
      storagePath,
      fileName: safeName,
      contentType: file.type || "application/octet-stream",
      size: file.size,
      downloadUrl,
      downloadCount: 0,
      createdAt: serverTimestamp(),
      expiresAt,
    });

    const shortUrl = sharePageUrl(shareId);
    shareUrl.value = shortUrl;
    openLink.href = shortUrl;
    result.hidden = false;
    progressText.textContent = "Upload complete.";
    await loadHistory();
  } catch (error) {
    showError(userMessage(error));
    progress.hidden = true;
  } finally {
    setBusy(false);
  }
});

async function loadHistory() {
  if (!auth.currentUser) return;
  historyList.innerHTML = "";
  historyEmpty.hidden = true;

  try {
    const snapshot = await getDocs(
      query(collection(db, "shares"), orderBy("createdAt", "desc"))
    );

    if (snapshot.empty) {
      historyEmpty.hidden = false;
      return;
    }

    const now = Date.now();
    for (const item of snapshot.docs) {
      const data = item.data();
      const expiresMs = data.expiresAt?.toMillis?.() ?? 0;
      const expired = expiresMs <= now;
      const li = document.createElement("li");
      li.className = "history-item";
      li.innerHTML = `
        <div>
          ${expired ? `<span class="badge expired">Expired</span>` : `<span class="badge">Active</span>`}
          <strong></strong>
        </div>
        <p class="meta"></p>
        <div class="history-actions">
          <button type="button" data-action="copy">Copy link</button>
          <button type="button" data-action="open">Open</button>
          <button type="button" class="danger" data-action="delete">Delete</button>
        </div>
      `;
      li.querySelector("strong").textContent = data.fileName || "File";
      li.querySelector(".meta").textContent = [
        formatBytes(data.size || 0),
        expired ? "expired" : `expires ${formatRelative(expiresMs)}`,
        `${data.downloadCount || 0} download${(data.downloadCount || 0) === 1 ? "" : "s"}`,
      ].join(" · ");

      const shortUrl = sharePageUrl(item.id);
      li.querySelector('[data-action="copy"]').addEventListener("click", async (event) => {
        const button = event.currentTarget;
        try {
          await navigator.clipboard.writeText(shortUrl);
          button.textContent = "Copied";
          setTimeout(() => {
            button.textContent = "Copy link";
          }, 1400);
        } catch {
          window.prompt("Copy this link", shortUrl);
        }
      });
      li.querySelector('[data-action="open"]').addEventListener("click", () => {
        window.open(shortUrl, "_blank", "noopener");
      });
      li.querySelector('[data-action="delete"]').addEventListener("click", async () => {
        if (!window.confirm(`Delete “${data.fileName}”?`)) return;
        await deleteShare(item.id, data.storagePath);
        await loadHistory();
      });

      historyList.appendChild(li);
    }
  } catch (error) {
    historyEmpty.hidden = false;
    historyEmpty.textContent = "Could not load history.";
    console.error(error);
  }
}

async function deleteShare(shareId, storagePath) {
  try {
    if (storagePath) {
      await deleteObject(ref(storage, storagePath));
    }
  } catch (error) {
    if (error?.code !== "storage/object-not-found") {
      console.error(error);
    }
  }
  await deleteDoc(doc(db, "shares", shareId));
}

async function loadDownloadPage(shareId) {
  const loading = document.querySelector("#download-loading");
  const errorBox = document.querySelector("#download-error");
  const ready = document.querySelector("#download-ready");
  const errorTitle = document.querySelector("#download-error-title");
  const errorText = document.querySelector("#download-error-text");
  const nameEl = document.querySelector("#dl-name");
  const metaEl = document.querySelector("#dl-meta");
  const expiryEl = document.querySelector("#dl-expiry");
  const button = document.querySelector("#dl-button");

  try {
    const snap = await getDoc(doc(db, "shares", shareId));
    if (!snap.exists()) {
      loading.hidden = true;
      errorBox.hidden = false;
      errorTitle.textContent = "File not found";
      errorText.textContent = "This link is invalid or the file was deleted.";
      return;
    }

    const data = snap.data();
    const expiresMs = data.expiresAt?.toMillis?.() ?? 0;
    if (expiresMs <= Date.now()) {
      loading.hidden = true;
      errorBox.hidden = false;
      errorTitle.textContent = "Link expired";
      errorText.textContent = "This file is no longer available.";
      return;
    }

    loading.hidden = true;
    ready.hidden = false;
    nameEl.textContent = data.fileName || "Download";
    metaEl.textContent = `${formatBytes(data.size || 0)} · ${data.contentType || "file"}`;
    expiryEl.textContent = `Available until ${new Date(expiresMs).toLocaleString()} (${formatRelative(expiresMs)})`;
    button.href = data.downloadUrl;
    button.setAttribute("download", data.fileName || "download");
    button.addEventListener("click", () => {
      recordDownload({ shareId }).catch(() => {});
    });
  } catch (error) {
    loading.hidden = true;
    errorBox.hidden = false;
    errorTitle.textContent = "Could not open link";
    errorText.textContent = "Try again in a moment.";
    console.error(error);
  }
}

function showView(name) {
  viewLogin.hidden = name !== "login";
  viewApp.hidden = name !== "app";
  viewDownload.hidden = name !== "download";
  if (name === "app" || name === "download") loadPageAds(name);
}

function loadPageAds(name) {
  const root = name === "download" ? viewDownload : viewApp;
  root.querySelectorAll("[data-ad-banner]").forEach((el) => {
    if (el.dataset.loaded) return;
    el.dataset.loaded = "1";
    window.atOptions = {
      key: el.dataset.key,
      format: "iframe",
      height: Number(el.dataset.height),
      width: Number(el.dataset.width),
      params: {},
    };
    const s = document.createElement("script");
    s.src = `https://www.highrevenueformat.com/${el.dataset.key}/invoke.js`;
    el.appendChild(s);
  });
  const native = root.querySelector("[data-ad-native]");
  if (native && !native.dataset.loaded) {
    native.dataset.loaded = "1";
    const s = document.createElement("script");
    s.async = true;
    s.dataset.cfasync = "false";
    s.src =
      "https://pl31376834.profitableratecpmnetwork.com/808e91bd3fc5754e3cadb7655110060e/invoke.js";
    native.prepend(s);
  }
}

function sharePageUrl(shareId) {
  return `${window.location.origin}/d/${shareId}`;
}

function setFileLabel(file) {
  fileLabel.textContent = file
    ? `${file.name} (${formatBytes(file.size)})`
    : "Drop a file here or click — up to 1 GB";
}

function sanitizeFileName(name) {
  const base = name.split(/[/\\]/).pop() || "file";
  return base.replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 180);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRelative(targetMs) {
  const diff = targetMs - Date.now();
  if (diff <= 0) return "expired";
  const hours = Math.round(diff / (60 * 60 * 1000));
  if (hours < 48) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

function showProgress(percent, label) {
  progress.hidden = false;
  progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  progressText.textContent = label;
}

function showError(message) {
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function hideError() {
  errorEl.hidden = true;
  errorEl.textContent = "";
}

function showEl(el, message) {
  el.hidden = false;
  el.textContent = message;
}

function hideEl(el) {
  el.hidden = true;
  el.textContent = "";
}

function setBusy(busy) {
  submitButton.disabled = busy;
  submitButton.textContent = busy ? "Uploading…" : "Upload";
  fileInput.disabled = busy;
  expirySelect.disabled = busy;
}

function userMessage(error) {
  const code = error?.code || "";
  const message = String(error?.message || "");

  if (
    code.includes("unauthenticated") ||
    message.toLowerCase().includes("invalid upload password")
  ) {
    return "Wrong upload password.";
  }
  if (code.includes("storage/unauthorized")) {
    return "Upload was rejected. Check Storage rules and Auth setup.";
  }
  if (code.includes("permission-denied")) {
    return "Permission denied. Try logging in again.";
  }
  if (code.includes("storage/canceled")) {
    return "Upload was canceled.";
  }
  if (message.includes("network") || code.includes("unavailable")) {
    return "Network error. Try again.";
  }
  return "Something went wrong. Try again.";
}
