/**
 * ============================================================
 *  SECURE FILE UPLOAD PORTAL — app.js
 *  Handles file selection, drag & drop, pre-signed URL
 *  generation via API, and S3 upload via PUT fetch.
 * ============================================================
 */

'use strict';

/* ──────────────────────────────────────────────
   CONFIG
   ────────────────────────────────────────────── */

/** Base URL of the Lambda/API Gateway that returns a pre-signed S3 URL. */
const API_BASE_URL =
  'https://s90wf9pt1k.execute-api.eu-north-1.amazonaws.com/generate-url';

/* ──────────────────────────────────────────────
   DOM REFERENCES
   ────────────────────────────────────────────── */

const dropZone          = document.getElementById('drop-zone');
const fileInput         = document.getElementById('file-input');
const filePreview       = document.getElementById('file-preview');
const fileNameEl        = document.getElementById('file-name');
const fileSizeEl        = document.getElementById('file-size');
const removeFileBtn     = document.getElementById('remove-file-btn');
const uploadBtn         = document.getElementById('upload-btn');
const uploadBtnIcon     = document.getElementById('upload-btn-icon');
const uploadBtnSpinner  = document.getElementById('upload-btn-spinner');
const uploadBtnText     = document.getElementById('upload-btn-text');
const progressContainer = document.getElementById('progress-container');
const progressBar       = document.getElementById('progress-bar');
const progressPercent   = document.getElementById('progress-percent');
const statusMsg         = document.getElementById('status-msg');

/* ──────────────────────────────────────────────
   STATE
   ────────────────────────────────────────────── */

/** @type {File|null} */
let selectedFile = null;

/* ──────────────────────────────────────────────
   HELPERS
   ────────────────────────────────────────────── */

/**
 * Format raw bytes into a human-readable string (e.g. "4.2 MB").
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = (bytes / Math.pow(1024, exp)).toFixed(exp === 0 ? 0 : 1);
  return `${val} ${units[exp]}`;
}

/**
 * Show or hide an element by toggling the `hidden` class.
 * @param {HTMLElement} el
 * @param {boolean}     show
 */
function setVisible(el, show) {
  el.classList.toggle('hidden', !show);
}

/**
 * Render a status message (success or error) with an SVG icon.
 * @param {'success'|'error'} type
 * @param {string}            message
 */
function showStatus(type, message) {
  const isSuccess = type === 'success';

  const iconPath = isSuccess
    ? /* checkmark circle */
      '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>' +
      '<path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
    : /* X circle */
      '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>' +
      '<path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';

  statusMsg.className = `status-msg ${type}`;
  statusMsg.innerHTML = `
    <svg class="status-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"
         aria-hidden="true">${iconPath}</svg>
    <span>${message}</span>
  `;
  setVisible(statusMsg, true);
}

/** Hide the status message banner. */
function clearStatus() {
  setVisible(statusMsg, false);
  statusMsg.className = 'status-msg hidden';
  statusMsg.innerHTML = '';
}

/** Reflect file selection in the preview strip and enable the upload button. */
function applyFileSelection(file) {
  selectedFile = file;

  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatFileSize(file.size);

  setVisible(filePreview, true);
  uploadBtn.disabled = false;
  clearStatus();
}

/** Reset everything back to the initial "no file selected" state. */
function resetUI() {
  selectedFile = null;
  fileInput.value = '';

  setVisible(filePreview, false);
  setVisible(progressContainer, false);

  progressBar.style.width = '0%';
  progressBar.classList.remove('indeterminate');
  progressPercent.textContent = '0%';
  progressContainer.setAttribute('aria-valuenow', '0');

  uploadBtn.disabled = true;
  uploadBtnIcon.classList.remove('hidden');
  uploadBtnSpinner.classList.add('hidden');
  uploadBtnText.textContent = 'Upload Securely';
  uploadBtn.disabled = true;

  clearStatus();
}

/**
 * Animate the progress bar smoothly to the given percentage.
 * @param {number} pct  0–100
 */
function setProgress(pct) {
  const clamped = Math.min(100, Math.max(0, pct));
  progressBar.style.width = `${clamped}%`;
  progressPercent.textContent = `${Math.round(clamped)}%`;
  progressContainer.setAttribute('aria-valuenow', String(Math.round(clamped)));
}

/* ──────────────────────────────────────────────
   CORE UPLOAD LOGIC
   ────────────────────────────────────────────── */

/**
 * Orchestrates the two-step secure upload flow:
 *  1. Fetch a pre-signed PUT URL from the API.
 *  2. Upload the file directly to S3 using that URL.
 */
async function uploadFile() {
  if (!selectedFile) return;

  // ── UI: uploading state ──
  clearStatus();
  uploadBtn.disabled = true;
  uploadBtnIcon.classList.add('hidden');
  uploadBtnSpinner.classList.remove('hidden');
  uploadBtnText.textContent = 'Uploading…';

  setVisible(progressContainer, true);
  progressBar.classList.add('indeterminate');
  setProgress(0);

  try {
    /* ── STEP 1: Get pre-signed URL ── */
    const encodedName = encodeURIComponent(selectedFile.name);
    const apiUrl = `${API_BASE_URL}?fileName=${encodedName}`;

    const urlResponse = await fetch(apiUrl);

    if (!urlResponse.ok) {
      throw new Error(
        `Failed to generate upload URL (HTTP ${urlResponse.status}). Please try again.`
      );
    }

    const urlData = await urlResponse.json();

    // The API returns either upload_url or uploadUrl – handle both.
    const presignedUrl = urlData.upload_url || urlData.uploadUrl;

    if (!presignedUrl) {
      throw new Error(
        'API response did not contain a valid upload URL. Contact support.'
      );
    }

    // Show 30% progress after getting the URL
    progressBar.classList.remove('indeterminate');
    setProgress(30);

    /* ── STEP 2: Upload to S3 via PUT ── */
    // Pre-signed S3 URLs require the exact Content-Type agreed upon at URL
    // generation time. We use application/octet-stream for universal compatibility.
    const uploadResponse = await fetch(presignedUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: selectedFile,
    });

    if (!uploadResponse.ok) {
      throw new Error(
        `S3 upload failed (HTTP ${uploadResponse.status}). Please try again.`
      );
    }

    // ── Success ──
    setProgress(100);

    showStatus(
      'success',
      `"${selectedFile.name}" uploaded successfully!`
    );

    // Reset the form after a short delay so the user can see the progress hit 100%
    setTimeout(() => {
      resetUI();
    }, 2800);

  } catch (err) {
    console.error('[Upload Error]', err);

    // ── Error ──
    progressBar.classList.remove('indeterminate');
    setVisible(progressContainer, false);

    showStatus('error', err.message || 'Upload failed. Please try again.');

    // Re-enable button so the user can retry
    uploadBtn.disabled = false;
    uploadBtnIcon.classList.remove('hidden');
    uploadBtnSpinner.classList.add('hidden');
    uploadBtnText.textContent = 'Retry Upload';
  }
}

/* ──────────────────────────────────────────────
   EVENT LISTENERS
   ────────────────────────────────────────────── */

/* File chosen via native picker */
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (file) applyFileSelection(file);
});

/* Remove selected file */
removeFileBtn.addEventListener('click', (e) => {
  e.stopPropagation(); // prevent triggering the drop-zone click
  resetUI();
});

/* Upload button click */
uploadBtn.addEventListener('click', uploadFile);

/* Keyboard accessibility: Enter/Space triggers the drop zone */
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fileInput.click();
  }
});

/* ── Drag & Drop ── */

dropZone.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault(); // required to allow drop
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', (e) => {
  // Only remove the highlight when leaving the drop zone entirely
  if (!dropZone.contains(e.relatedTarget)) {
    dropZone.classList.remove('drag-over');
  }
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');

  const file = e.dataTransfer?.files[0];
  if (file) {
    applyFileSelection(file);
    // Sync the file input so the form state is consistent
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
    } catch (_) {
      // DataTransfer mutation not supported in all browsers — safe to ignore
    }
  }
});

/* Prevent the entire page from accidentally handling drag events */
document.addEventListener('dragover',  (e) => e.preventDefault());
document.addEventListener('drop',      (e) => e.preventDefault());
