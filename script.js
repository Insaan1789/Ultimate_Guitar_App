/**
 * Guitar Tuner Logic - Pro Version
 * Features: Autocorrelation, Frequency Locking, Needle Smoothing, Confirmation Sound, Reference Tones
 */

// --- Configuration ---
const config = {
    bufferSize: 4096,
    confidenceThreshold: 0.9,
    minFreq: 60,
    maxFreq: 1000,
    tunedTolerance: 5,   // Cents within which it counts as "tuned"
    stableDuration: 600, // ms to wait before confirming tune (slightly longer for better UX)
    silenceRMS: 0.015    // Threshold for "Too Quiet"
};

// --- State ---
let audioContext = null;
let analyser = null;
let microphone = null;
let isRunning = false;
let currentString = 'AUTO';
let currentRMS = 0; // Track volume

// Smoothing State
let currentNeedleAngle = 0;
let targetNeedleAngle = 0;
let lastFrameTime = 0;

// Stability State
let timeInTune = 0;
let hasPlayedSound = false;

// Reference Tone State
let activeOscillator = null;
let activeToneBtn = null;

// String Frequencies & Windows (Strict)
// Mutable to allow tuning changes
let guitarStrings = {
    'E2': { freq: 82.41, min: 70, max: 95 },
    'A2': { freq: 110.00, min: 95, max: 125 },
    'D3': { freq: 146.83, min: 130, max: 165 },
    'G3': { freq: 196.00, min: 175, max: 215 },
    'B3': { freq: 246.94, min: 225, max: 270 },
    'E4': { freq: 329.63, min: 300, max: 360 }
};

// --- DATA: Instrument Tunings ---
const INSTRUMENTS = {
    guitar: {
        name: "Guitar (6 String)",
        tunings: [
            { name: "Standard", notes: ["E2", "A2", "D3", "G3", "B3", "E4"] },
            { name: "Drop D", notes: ["D2", "A2", "D3", "G3", "B3", "E4"] },
            { name: "Open D", notes: ["D2", "A2", "D3", "F#3", "A3", "D4"] },
            { name: "Open G", notes: ["D2", "G2", "D3", "G3", "B3", "D4"] },
            { name: "DADGAD", notes: ["D2", "A2", "D3", "G3", "A3", "D4"] },
            { name: "Half Step Down", notes: ["Eb2", "Ab2", "Db3", "Gb3", "Bb3", "Eb4"] }
        ]
    },
    bass: {
        name: "Bass (4 String)",
        tunings: [
            { name: "Standard", notes: ["E1", "A1", "D2", "G2"] },
            { name: "Drop D", notes: ["D1", "A1", "D2", "G2"] },
            { name: "Half Step Down", notes: ["Eb1", "Ab1", "Db2", "Gb2"] }
        ]
    },
    ukulele: {
        name: "Ukulele",
        tunings: [
            { name: "Standard (GCEA)", notes: ["G4", "C4", "E4", "A4"] },
            { name: "D Tuning (ADF#B)", notes: ["A4", "D4", "F#4", "B4"] },
            { name: "Low G", notes: ["G3", "C4", "E4", "A4"] }
        ]
    },
    violin: {
        name: "Violin Family",
        tunings: [
            { name: "Violin", notes: ["G3", "D4", "A4", "E5"] },
            { name: "Viola", notes: ["C3", "G3", "D4", "A4"] },
            { name: "Cello", notes: ["C2", "G2", "D3", "A3"] }
        ]
    },
    folk: {
        name: "Folk Instruments",
        tunings: [
            { name: "Mandolin", notes: ["G3", "D4", "A4", "E5"] },
            { name: "Banjo (5-String)", notes: ["G4", "D3", "G3", "B3", "D4"] },
            { name: "Balalaika", notes: ["E4", "E4", "A4"] },
            { name: "Cavaquinho", notes: ["D4", "G4", "B4", "D5"] }
        ]
    }
};

// NOTE DATA (Frequency map for generating targets dynamically)
// A4 = 440Hz
const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
function getNoteFreq(noteWithOctave) {
    // Regex to split Note and Octave (handle C#2, Eb4, etc)
    const match = noteWithOctave.match(/^([A-Ga-g]+#?b?)(\d+)$/);
    if (!match) return 0;

    let note = match[1];
    const octave = parseInt(match[2]);

    // Normalize flat/sharp
    const flatToSharp = { "Eb": "D#", "Ab": "G#", "Bb": "A#", "Db": "C#", "Gb": "F#" };
    if (flatToSharp[note]) note = flatToSharp[note];

    // Calculate semitones from A4
    const noteIndex = NOTE_NAMES.indexOf(note);
    // A is index 9
    // A4 index absolute = 4 * 12 + 9 = 57
    const a4Index = 57;
    const thisIndex = octave * 12 + noteIndex;

    const diff = thisIndex - a4Index;
    return 440 * Math.pow(2, diff / 12);
}

// Current Tuning State
let activeTuningName = "Standard";
let activeInstrument = "guitar";
let isChromaticMode = false;
let headstockLayout = '3+3';

// Custom Tunings State
let customTunings = [];
try {
    const stored = localStorage.getItem('custom-tunings');
    if (stored) customTunings = JSON.parse(stored);
} catch (e) { console.error("Error loading custom tunings", e); }

// Editor State
let editingTuningId = null; // null = creating new
let tempEditingState = { name: "", strings: [], headstock: "3+3" };
let activeStringEditIndex = -1; // Which string are we picking a note for?


// --- DOM Elements ---
const startBtn = document.getElementById('start-btn');
const statusMsg = document.getElementById('status-message');
const noteNameEl = document.getElementById('note-name');
const noteOctaveEl = document.getElementById('note-octave');
const freqEl = document.getElementById('frequency');
const needleEl = document.getElementById('tuner-needle');
const needleGlowEl = document.querySelector('.needle-glow');
const stabilityBar = document.getElementById('stability-bar');
const tuningStatusEl = document.getElementById('tuning-status');
const stringBtns = document.querySelectorAll('.string-btn');
const toneBtns = document.querySelectorAll('.tone-btn');
const autoBtn = document.getElementById('auto-mode-btn');
const themeToggle = document.getElementById('theme-toggle');

// Tuning UI Elements
const tuningSelectBtn = document.getElementById('tuning-select-btn');
const tuningScreen = document.getElementById('tuning-selection-screen');
const closeTuningBtn = document.getElementById('close-tuning-btn');
const instrumentAccordion = document.getElementById('instrument-accordion');
const recentList = document.getElementById('recent-tunings-list');
const headstockBtns = document.querySelectorAll('.toggle-option');
const stringGrid = document.querySelector('.string-grid');

// Custom Editor Elements
const customEditor = document.getElementById('custom-tuning-editor');
const customNameInput = document.getElementById('custom-name-input');
const stringsMinusBtn = document.getElementById('strings-minus');
const stringsPlusBtn = document.getElementById('strings-plus');
const stringCountDisplay = document.getElementById('string-count-display');
const customHeadstockBtn = document.getElementById('custom-headstock-toggle');
const stringEditorList = document.getElementById('string-editor-list');
const saveCustomBtn = document.getElementById('save-custom-btn');
const cancelCustomBtn = document.getElementById('cancel-custom-btn');
const deleteCustomBtn = document.getElementById('delete-custom-btn');
const deleteWrapper = document.getElementById('delete-tuning-wrapper');

// Note Picker Elements
const notePickerModal = document.getElementById('note-picker-modal');
const notePickerGrid = document.getElementById('note-picker-grid');
const closePickerBtn = document.getElementById('close-picker-btn');
const octaveBtns = document.querySelectorAll('.octave-btn');

// --- Initialization ---

async function initAudio() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }
    return audioContext;
}

async function startTuner() {
    if (isRunning) return;

    try {
        await initAudio();

        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        microphone = audioContext.createMediaStreamSource(stream);
        microphone.connect(analyser);

        isRunning = true;
        startBtn.innerHTML = '<span class="icon">⏹</span> Stop Tuner';
        startBtn.classList.add('stop');
        statusMsg.textContent = "Listening...";
        statusMsg.className = 'status-pill good';

        lastFrameTime = performance.now();
        requestAnimationFrame(updateLoop);

    } catch (err) {
        console.error("Mic Error:", err);
        statusMsg.textContent = "Mic Access Denied";
        statusMsg.className = 'status-pill warning';
        alert("Please allow microphone access to tune your guitar.");
    }
}

function stopTuner() {
    if (!isRunning) return;

    if (microphone) microphone.disconnect();

    // Stop any reference tone
    stopReferenceTone();

    isRunning = false;
    startBtn.innerHTML = '<span class="icon">🎤</span> Start Tuner';
    startBtn.classList.remove('stop');
    statusMsg.textContent = "Ready to Tune";
    statusMsg.className = 'status-pill';

    resetUI();
}

startBtn.addEventListener('click', () => {
    if (isRunning) stopTuner();
    else startTuner();
});

// --- Settings & Theme ---
// Load Theme
const savedTheme = localStorage.getItem('tuner-theme');
if (savedTheme) document.body.setAttribute('data-theme', savedTheme);
updateThemeIcon();

themeToggle.addEventListener('click', () => {
    const isDark = !document.body.hasAttribute('data-theme'); // default is dark, so if attribute absent -> dark
    // But logic: if data-theme="light", it's light.
    const current = document.body.getAttribute('data-theme');
    if (current === 'light') {
        document.body.removeAttribute('data-theme');
        localStorage.setItem('tuner-theme', 'dark');
    } else {
        document.body.setAttribute('data-theme', 'light');
        localStorage.setItem('tuner-theme', 'light');
    }
    updateThemeIcon();
});

function updateThemeIcon() {
    const isLight = document.body.getAttribute('data-theme') === 'light';
    document.querySelector('.sun-icon').style.display = isLight ? 'none' : 'block';
    document.querySelector('.moon-icon').style.display = isLight ? 'block' : 'none';
}

// Restore String/Mode
const savedString = localStorage.getItem('last-string');
if (savedString) {
    if (savedString === 'AUTO') {
        activateAutoMode();
    } else {
        const btn = Array.from(stringBtns).find(b => b.dataset.note === savedString);
        if (btn) selectString(btn);
    }
}

// --- String Selection ---
function selectString(btn) {
    // Need to re-query as buttons are dynamic now
    const currentBtns = document.querySelectorAll('.string-btn');
    currentBtns.forEach(b => b.classList.remove('active'));
    autoBtn.classList.remove('active');

    btn.classList.add('active');
    currentString = btn.dataset.note;
    localStorage.setItem('last-string', currentString);

    // Initial visual update
    updateNoteDisplay(currentString.replace(/\d/, ''), currentString.slice(-1), false);
    statusMsg.textContent = `Target: ${currentString} (${guitarStrings[currentString].freq} Hz)`;

    // Reset Logic
    resetProcessing();
}

function activateAutoMode() {
    const currentBtns = document.querySelectorAll('.string-btn');
    currentBtns.forEach(b => b.classList.remove('active'));
    autoBtn.classList.add('active');
    currentString = 'AUTO';
    localStorage.setItem('last-string', 'AUTO');

    statusMsg.textContent = "Auto Mode";
    resetProcessing();
}

stringBtns.forEach(btn => {
    btn.addEventListener('click', () => selectString(btn));
});

autoBtn.addEventListener('click', activateAutoMode);

function resetProcessing() {
    hasPlayedSound = false;
    timeInTune = 0;
    targetNeedleAngle = 0;
    stabilityBar.style.width = '0%';
}

// --- Reference Tones ---
toneBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.stopPropagation(); // Don't select string if clicking tone
        toggleReferenceTone(btn);
    });
});

// --- Tuning Selection Logic ---

// 1. toggle Screen
tuningSelectBtn.addEventListener('click', () => {
    renderRecentTunings(); // Refresh recent
    renderInstrumentList(); // Ensure list is built
    tuningScreen.classList.remove('hidden');
});

closeTuningBtn.addEventListener('click', () => {
    tuningScreen.classList.add('hidden');
});

// 2. Apply Tuning
function applyTuning(instrument, tuningName, notesArray, isCustom = false) {
    // 1. Update State
    activeInstrument = instrument;
    activeTuningName = tuningName;
    isChromaticMode = (instrument === 'chromatic');

    // 2. Generate Target Strings Object
    const newStrings = {};
    if (isChromaticMode) {
        // Generate ALL notes from C1 to B6 (just a wide range approx)
        // Actually, just generate a huge map? 
        // Or better: keep guitarStrings empty and use a special logic in detectNote?
        // To keep existing logic intact ("processPitch" relies on guitarStrings),
        // we will generating 'guitarStrings' with ALL semitones relevant to the instrument range?
        // No, for "Chromatic", we'll populate it with a wide range of notes.
        // Let's do E1 to E6 roughly for general usage.

        for (let i = 1; i <= 6; i++) {
            NOTE_NAMES.forEach(n => {
                const note = n + i;
                const f = getNoteFreq(note);
                // Windows can overlap in chromatic, simply find closest.
                newStrings[note] = { freq: f, min: f * 0.94, max: f * 1.06 };
            });
        }
    } else {
        notesArray.forEach(note => {
            const f = getNoteFreq(note);
            // +/- 15% window approx or manual define? 
            // Using logic from original: E2(82) had range 70-95. That's approx -15% +15%.
            newStrings[note] = { freq: f, min: f * 0.85, max: f * 1.15 };
        });
    }

    guitarStrings = newStrings;

    // 3. Update UI
    if (!isChromaticMode) {
        renderStringButtons(notesArray);
        tuningSelectBtn.textContent = (instrument === 'guitar' && tuningName === 'Standard')
            ? 'Standard Tuning'
            : `${tuningName}`;
    } else {
        // Chromatic UI
        stringGrid.innerHTML = '<div style="color:var(--text-dim); padding:1rem;">Chromatic Mode Active</div>';
        tuningSelectBtn.textContent = "Chromatic";
    }

    // 4. Persistence
    if (!isCustom && !isChromaticMode) {
        addToRecent(instrument, tuningName, notesArray);
    }

    // Auto-select "Auto" mode
    activateAutoMode();

    // Close screen
    tuningScreen.classList.add('hidden');
}

function renderStringButtons(notes) {
    stringGrid.innerHTML = '';

    // Headstock layout logic?
    // For now simple flex wrap. original CSS handles it well. 
    // If logic needed:
    if (headstockLayout === '6-in-line') {
        // Maybe adjust grid gap or directions in CSS via class
        stringGrid.style.flexWrap = 'nowrap';
    } else {
        stringGrid.style.flexWrap = 'wrap';
    }


    notes.forEach(note => {
        const freq = guitarStrings[note].freq; // Should exist now

        const div = document.createElement('div');
        div.className = 'string-item';

        // String Button
        const btn = document.createElement('button');
        btn.className = 'string-btn';
        btn.dataset.note = note;
        btn.dataset.freq = freq;
        // Strip octave for display if it's standard? Or keep?
        // Original showed "E", "A" etc. 
        // We'll show just Note name, maybe octave small?
        const displayNote = note.replace(/\d/, '');
        btn.textContent = displayNote;

        btn.onclick = () => selectString(btn);

        // Tone Button
        const tone = document.createElement('button');
        tone.className = 'tone-btn';
        tone.dataset.note = note;
        tone.textContent = '🔊';
        tone.onclick = (e) => {
            e.stopPropagation();
            toggleReferenceTone(tone);
        };

        div.appendChild(btn);
        div.appendChild(tone);
        stringGrid.appendChild(div);
    });

    // Re-bind global var stringBtns? 
    // Actually our selectString logic uses document.querySelectorAll('.string-btn') ?
    // No, it used a specific list. We need to update that list or delegate.
    // The original code used `stringBtns.forEach`. That won't work for dynamic buttons.
    // We fixed the onclick above to call `selectString(btn)`.
}

// 3. Render Lists
function renderInstrumentList() {
    instrumentAccordion.innerHTML = '';

    // 1. My Tunings (if any)
    if (customTunings.length > 0) {
        const item = document.createElement('div');
        item.className = 'accordion-item';
        // Open by default if active instrument is custom?
        if (activeInstrument === 'custom') item.classList.add('open');

        const header = document.createElement('button');
        header.className = 'accordion-header';
        header.innerHTML = `<span>My Tunings (${customTunings.length})</span> <span class="accordion-icon">▼</span>`;
        header.onclick = () => {
            const isOpen = item.classList.contains('open');
            document.querySelectorAll('.accordion-item').forEach(i => i.classList.remove('open'));
            if (!isOpen) item.classList.add('open');
        };

        const content = document.createElement('div');
        content.className = 'accordion-content';

        customTunings.forEach(t => {
            const row = document.createElement('button');
            row.className = 'tuning-item custom-tuning-row';
            if (activeInstrument === 'custom' && activeTuningName === t.name) {
                row.classList.add('active');
            }

            // Edit Button (Icon)
            const mainClickDiv = document.createElement('div');
            mainClickDiv.className = 'tuning-info';
            mainClickDiv.style.flex = '1';
            mainClickDiv.innerHTML = `
                <span class="tuning-name">${t.name}</span>
                <span class="tuning-notes">${t.notes.join(' ')}</span>
            `;
            mainClickDiv.onclick = (e) => {
                applyTuning('custom', t.name, t.notes, true);
                if (t.headstock) {
                    headstockLayout = t.headstock;
                    headstockBtns.forEach(b => b.classList.toggle('active', b.dataset.layout === headstockLayout));
                    // Re-render handled by apply... wait apply calls renderStringButtons.
                    // We modify headstockLayout AFTER apply in save, but here we do it before/after?
                    // We should re-render strings to match custom layout preference
                    renderStringButtons(t.notes);
                }
            };

            const editBtn = document.createElement('button');
            editBtn.innerHTML = '✎';
            editBtn.className = 'icon-btn small';
            editBtn.style.opacity = '0.5';
            editBtn.onclick = (e) => {
                e.stopPropagation();
                openCustomEditor(t.id);
            };

            row.appendChild(mainClickDiv);
            if (activeInstrument === 'custom' && activeTuningName === t.name) {
                const check = document.createElement('span');
                check.className = 'checkmark';
                check.textContent = '✓';
                row.appendChild(check);
            }
            row.appendChild(editBtn);

            content.appendChild(row);
        });

        item.appendChild(header);
        item.appendChild(content);
        instrumentAccordion.appendChild(item);
    }

    for (const [key, data] of Object.entries(INSTRUMENTS)) {
        const item = document.createElement('div');
        item.className = 'accordion-item';

        // Header
        const header = document.createElement('button');
        header.className = 'accordion-header';
        header.innerHTML = `<span>${data.name}</span> <span class="accordion-icon">▼</span>`;
        header.onclick = () => {
            // Toggle
            const isOpen = item.classList.contains('open');
            document.querySelectorAll('.accordion-item').forEach(i => i.classList.remove('open'));
            if (!isOpen) item.classList.add('open');
        };

        // Content
        const content = document.createElement('div');
        content.className = 'accordion-content';

        // Tuning Options
        data.tunings.forEach(t => {
            const row = document.createElement('button');
            row.className = 'tuning-item';
            if (activeInstrument === key && activeTuningName === t.name) {
                row.classList.add('active');
            }

            row.innerHTML = `
                <div class="tuning-info">
                    <span class="tuning-name">${t.name}</span>
                    <span class="tuning-notes">${t.notes.join(' ')}</span>
                </div>
                ${(activeInstrument === key && activeTuningName === t.name) ? '<span class="checkmark">✓</span>' : ''}
            `;

            row.onclick = () => applyTuning(key, t.name, t.notes);

            content.appendChild(row);
        });

        item.appendChild(header);
        item.appendChild(content);
        instrumentAccordion.appendChild(item);
    }
}

// 4. Headstock Toggle
headstockBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        headstockBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        headstockLayout = btn.dataset.layout;
        // Re-render current if not chromatic
        // Actually just need to update visual?
        if (!isChromaticMode) {
            const tData = INSTRUMENTS[activeInstrument]?.tunings.find(t => t.name === activeTuningName);
            if (tData) renderStringButtons(tData.notes);
        }
    });
});

// 5. Recent Tunings
function addToRecent(inst, name, notes) {
    let recent = JSON.parse(localStorage.getItem('recent-tunings') || '[]');
    // Remove if exists (to bring to top)
    recent = recent.filter(r => !(r.inst === inst && r.name === name));

    recent.unshift({ inst, name, notes });
    if (recent.length > 5) recent.pop();

    localStorage.setItem('recent-tunings', JSON.stringify(recent));
}

function renderRecentTunings() {
    recentList.innerHTML = '';
    const recent = JSON.parse(localStorage.getItem('recent-tunings') || '[]');

    if (recent.length === 0) {
        recentList.innerHTML = '<div style="color:var(--text-dim); font-size:0.9rem; padding:0.5rem">No recent tunings</div>';
        return;
    }

    recent.forEach(r => {
        const row = document.createElement('button');
        row.className = 'tuning-item';
        // highlight if active?

        row.innerHTML = `
             <div class="tuning-info">
                <span class="tuning-name">${r.inst === 'guitar' ? '' : r.inst + ': '}${r.name}</span>
                <span class="tuning-notes">${r.notes.join(' ')}</span>
            </div>
        `;
        row.onclick = () => applyTuning(r.inst, r.name, r.notes);
        recentList.appendChild(row);
    });
}

// Chromatic / Custom handlers
document.querySelector('[data-type="chromatic"]').addEventListener('click', () => {
    applyTuning('chromatic', 'Chromatic', []);
});

document.querySelector('[data-type="custom"]').addEventListener('click', () => {
    // Open Editor New
    openCustomEditor(null);
});

// Update detectNote to handle dynamic objects better (it already iterates logicly)
// No changes needed to detectNote since it iterates `guitarStrings`.

// --- Custom Tuning Editor Logic ---
function openCustomEditor(tuningId) {
    editingTuningId = tuningId;

    if (tuningId) {
        // Edit Mode
        const t = customTunings.find(c => c.id === tuningId);
        if (!t) return; // Error
        tempEditingState = {
            name: t.name,
            strings: [...t.notes], // Copy
            headstock: t.headstock || "3+3"
        };
        deleteWrapper.classList.remove('hidden');
    } else {
        // New Mode (Default 6 string E2..E4 same as standard)
        tempEditingState = {
            name: "",
            strings: ["E2", "A2", "D3", "G3", "B3", "E4"],
            headstock: "3+3"
        };
        deleteWrapper.classList.add('hidden');
    }

    // Render
    customNameInput.value = tempEditingState.name;
    customHeadstockBtn.textContent = tempEditingState.headstock;
    renderEditorStrings();

    customEditor.classList.remove('hidden');
}

function renderEditorStrings() {
    stringCountDisplay.textContent = tempEditingState.strings.length;
    stringEditorList.innerHTML = '';

    tempEditingState.strings.forEach((note, index) => {
        const row = document.createElement('div');
        row.className = 'string-edit-row';
        row.innerHTML = `
            <span class="string-num">${index + 1}</span>
            <button class="note-pill-btn">${note}</button>
        `;

        row.querySelector('.note-pill-btn').onclick = () => openNotePicker(index);
        stringEditorList.appendChild(row);
    });
}

// Editor Actions
stringsMinusBtn.addEventListener('click', () => {
    if (tempEditingState.strings.length > 1) {
        tempEditingState.strings.pop();
        renderEditorStrings();
    }
});

stringsPlusBtn.addEventListener('click', () => {
    if (tempEditingState.strings.length < 8) {
        // Add a default string (e.g. correct 4th/5th or just duplicate last)
        const last = tempEditingState.strings[tempEditingState.strings.length - 1];
        // naive: repeat last or Add 5 semitones? Just repeat.
        tempEditingState.strings.push(last || "E2");
        renderEditorStrings();
    }
});

customHeadstockBtn.addEventListener('click', () => {
    tempEditingState.headstock = tempEditingState.headstock === '3+3' ? '6-in-line' : '3+3';
    customHeadstockBtn.textContent = tempEditingState.headstock;
});

cancelCustomBtn.addEventListener('click', () => {
    customEditor.classList.add('hidden');
});

saveCustomBtn.addEventListener('click', () => {
    saveCustomTuning();
});

deleteCustomBtn.addEventListener('click', () => {
    if (confirm("Delete this tuning?")) {
        customTunings = customTunings.filter(c => c.id !== editingTuningId);
        saveCustomTuningsToLS();
        renderInstrumentList(); // Refresh lists
        customEditor.classList.add('hidden');
    }
});

function saveCustomTuning() {
    const name = customNameInput.value.trim() || `Custom ${tempEditingState.strings.length}-String`;

    if (editingTuningId) {
        // Update
        const idx = customTunings.findIndex(c => c.id === editingTuningId);
        if (idx !== -1) {
            customTunings[idx] = {
                ...customTunings[idx],
                name: name,
                notes: tempEditingState.strings,
                headstock: tempEditingState.headstock,
                updatedAt: Date.now()
            };
        }
    } else {
        // Create
        const newTuning = {
            id: 'ct_' + Date.now(),
            name: name,
            notes: tempEditingState.strings,
            headstock: tempEditingState.headstock,
            createdAt: Date.now()
        };
        customTunings.push(newTuning);
        editingTuningId = newTuning.id; // Set ID so we can apply it
    }

    saveCustomTuningsToLS();
    renderInstrumentList();

    // Apply and close
    customEditor.classList.add('hidden');

    // Special handling for Custom apply
    // We treat it as "guitar" type essentially, or "custom"
    applyTuning('custom', name, tempEditingState.strings, true);

    // Update headstock global pref?
    // User requested "Let user select 3+3... affects only UI"
    // So we should respect it
    if (headstockLayout !== tempEditingState.headstock) {
        // visual update? 
        // In applyTuning logic, we default to global headstockLayout.
        // We should probably update global or handle it per tuning.
        // For now, let's update global to match custom choice
        headstockLayout = tempEditingState.headstock;
        // Update toggle buttons in main selector
        headstockBtns.forEach(b => {
            b.classList.toggle('active', b.dataset.layout === headstockLayout);
        });
        renderStringButtons(tempEditingState.strings); // Re-render with new layout logic if any
    }
}

function saveCustomTuningsToLS() {
    localStorage.setItem('custom-tunings', JSON.stringify(customTunings));
}

// --- Note Picker Logic ---
// --- Note Picker Logic ---
let tempPickerState = { note: "E", octave: 2 };
const applyNoteBtn = document.getElementById('apply-note-btn');

function openNotePicker(index) {
    activeStringEditIndex = index;
    const currentNote = tempEditingState.strings[index];

    // Parse current
    const match = currentNote.match(/^([A-Ga-g]+#?b?)(\d+)$/);
    if (match) {
        tempPickerState.note = match[1];
        tempPickerState.octave = parseInt(match[2]);
    } else {
        tempPickerState.note = "E";
        tempPickerState.octave = 2;
    }

    renderNotePickerUI();
    notePickerModal.classList.remove('hidden');
}

function renderNotePickerUI() {
    // 1. Grid
    renderNotePickerGrid();

    // 2. Octave Buttons
    octaveBtns.forEach(b => {
        const o = parseInt(b.dataset.oct);
        b.classList.toggle('active', o === tempPickerState.octave);

        // Re-bind to ensure it updates temp state
        b.onclick = () => {
            tempPickerState.octave = o;
            renderNotePickerUI(); // Re-render to update active classes
        };
    });
}

function renderNotePickerGrid() {
    notePickerGrid.innerHTML = '';
    const notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

    notes.forEach(note => {
        const btn = document.createElement('button');
        btn.className = 'note-cell-btn';
        if (note === tempPickerState.note) btn.classList.add('active');
        btn.textContent = note;

        btn.onclick = () => {
            tempPickerState.note = note;
            renderNotePickerGrid(); // Just update UI, don't close
        };

        notePickerGrid.appendChild(btn);
    });
}

// Confirm Action
applyNoteBtn.addEventListener('click', () => {
    finishNotePick(tempPickerState.note, tempPickerState.octave);
});

function finishNotePick(note, octave) {
    const fullNote = `${note}${octave}`;
    if (activeStringEditIndex >= 0) {
        tempEditingState.strings[activeStringEditIndex] = fullNote;
        renderEditorStrings();
    }
    closeNotePicker();
}

function closeNotePicker() {
    notePickerModal.classList.add('hidden');
    activeStringEditIndex = -1;
}

closePickerBtn.addEventListener('click', closeNotePicker);
function previewNote(note, octave) {
    // Optional: Play sound?
    // For now just update internal tracking if needed. 
}

// --- Update Render Functions ---
// We need to inject "My Tunings" into the accordion




function toggleReferenceTone(btn) {
    // If clicking active button, stop
    if (activeToneBtn === btn) {
        stopReferenceTone();
        return;
    }

    // Stop existing if any
    stopReferenceTone();

    // Start new
    const note = btn.dataset.note;
    const freq = guitarStrings[note].freq;

    playToneLoop(freq);

    btn.classList.add('playing');
    activeToneBtn = btn;
    statusMsg.textContent = `Playing ${note}...`;
}

function stopReferenceTone() {
    if (activeOscillator) {
        try {
            activeOscillator.stop();
            activeOscillator.disconnect();
        } catch (e) { }
        activeOscillator = null;
    }
    if (activeToneBtn) {
        activeToneBtn.classList.remove('playing');
        activeToneBtn = null;
        if (isRunning) statusMsg.textContent = "Listening...";
        else statusMsg.textContent = "Ready";
    }
}

function playToneLoop(freq) {
    if (!audioContext) initAudio();

    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc.type = 'sine';
    osc.frequency.value = freq;

    gain.gain.value = 0.1; // Low volume

    osc.connect(gain);
    gain.connect(audioContext.destination);

    osc.start();
    activeOscillator = osc;
}

// --- Core Loop ---

function updateLoop(time) {
    if (!isRunning) return;

    const dt = time - lastFrameTime;
    lastFrameTime = time;

    // 1. Audio Analysis
    const buffer = new Float32Array(config.bufferSize);
    analyser.getFloatTimeDomainData(buffer);

    // Calculate RMS for noise gate
    let rms = 0;
    for (let i = 0; i < buffer.length; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / buffer.length);
    currentRMS = rms;

    const frequency = autoCorrelate(buffer, audioContext.sampleRate, rms);

    // 2. Logic Processing
    processPitch(frequency, dt);

    // 3. UI Movement (Lerp)
    smoothNeedle(dt);

    requestAnimationFrame(updateLoop);
}

// --- Pitch Processing ---

function processPitch(frequency, dt) {
    if (frequency === -1) {
        // Silence / Noise
        targetNeedleAngle = 0;
        timeInTune = 0;
        stabilityBar.style.width = '0%';
        needleGlowEl.style.opacity = 0;

        // Show noise feedback
        if (currentRMS < config.silenceRMS) {
            tuningStatusEl.textContent = "PLAY STRING";
            tuningStatusEl.className = "tuning-status idle";
        } else {
            // Noisy but no pitch found
            // statusMsg.textContent = "Background noise..."; 
            // Don't spam statusMsg, maybe just keep idle
        }
        return;
    }

    // Got a pitch
    tuningStatusEl.className = "tuning-status"; // Remove idle float

    let targetFreq = 0;
    let noteName = "";
    let octave = "";
    let centDiff = 0;
    let isValidPitch = false;

    // AUTO MODE
    if (currentString === 'AUTO') {
        const detected = detectNote(frequency);
        if (detected) {
            targetFreq = detected.freq;
            noteName = detected.note.replace(/\d/, '');
            octave = detected.note.slice(-1);
            centDiff = calculateCents(frequency, targetFreq);
            isValidPitch = true;
        }
    }
    // MANUAL MODE
    else {
        const s = guitarStrings[currentString];
        if (frequency >= s.min && frequency <= s.max) {
            targetFreq = s.freq;
            noteName = currentString.replace(/\d/, '');
            octave = currentString.slice(-1);
            centDiff = calculateCents(frequency, targetFreq);
            isValidPitch = true;
        }
    }

    if (isValidPitch) {
        // Update Displays
        freqEl.textContent = frequency.toFixed(1);

        // Update Note Info (only change if meaningful change to avoid flicker?)
        // Actually, CSS transitions handle flicker elegantly
        updateNoteDisplay(noteName, octave, true);

        // Needle Target (-45 to 45 deg)
        const clamp = Math.max(-50, Math.min(50, centDiff));
        targetNeedleAngle = clamp * (1.1); // Scale up slightly to use full gauge

        updateIndicators(centDiff, dt);
    } else {
        // Valid freq but not in expected range (Manual Mode ignore)
        targetNeedleAngle = 0;
    }
}

function updateNoteDisplay(note, octave, isActive) {
    noteNameEl.textContent = note;
    noteOctaveEl.textContent = octave;

    if (isActive) {
        noteNameEl.classList.add('active');
    } else {
        noteNameEl.classList.remove('active');
        noteNameEl.classList.remove('in-tune');
    }
}

function updateIndicators(cents, dt) {
    const absCents = Math.abs(cents);
    const inTune = absCents <= config.tunedTolerance;

    if (inTune) {
        noteNameEl.classList.add('in-tune');
        tuningStatusEl.textContent = "PERFECT";
        tuningStatusEl.style.color = 'var(--accent-green)';

        // Glow Intensity
        needleGlowEl.style.opacity = 1;

        // Stability Increase
        timeInTune += dt;
        const progress = Math.min(100, (timeInTune / config.stableDuration) * 100);
        stabilityBar.style.width = `${progress}%`;

        if (timeInTune > config.stableDuration && !hasPlayedSound) {
            playConfirmationSound();
            hasPlayedSound = true;
            statusMsg.textContent = "String Tuned!";
            statusMsg.className = "status-pill good";
        }
    } else {
        noteNameEl.classList.remove('in-tune');
        needleGlowEl.style.opacity = 0.2; // Dim glow

        // Reset stability
        timeInTune = 0;
        stabilityBar.style.width = '0%';
        hasPlayedSound = false;

        if (cents < 0) {
            tuningStatusEl.textContent = "TOO LOW";
            tuningStatusEl.style.color = '#ffaa00';
            needleEl.style.backgroundColor = '#ffaa00';
        } else {
            tuningStatusEl.textContent = "TOO HIGH";
            tuningStatusEl.style.color = 'var(--accent-red)';
            needleEl.style.backgroundColor = 'var(--accent-red)';
        }
    }

    if (inTune) needleEl.style.backgroundColor = 'var(--accent-green)';
}

function playConfirmationSound() {
    if (!audioContext) return;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioContext.currentTime); // High A

    gain.gain.setValueAtTime(0.1, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.3);

    osc.connect(gain);
    gain.connect(audioContext.destination);

    osc.start();
    osc.stop(audioContext.currentTime + 0.3);
}

function smoothNeedle(dt) {
    // Smooth check
    const diff = targetNeedleAngle - currentNeedleAngle;
    if (Math.abs(diff) < 0.1) {
        currentNeedleAngle = targetNeedleAngle;
    } else {
        // Lerp factor
        currentNeedleAngle += diff * 0.15;
    }
    needleEl.style.transform = `rotate(${currentNeedleAngle}deg)`;
}

function resetUI() {
    currentNeedleAngle = 0;
    targetNeedleAngle = 0;
    freqEl.textContent = "0.0";
    noteNameEl.textContent = "--";
    noteOctaveEl.textContent = "";
    tuningStatusEl.textContent = "PLAY STRING";
    tuningStatusEl.style.color = "var(--text-dim)";
    tuningStatusEl.className = "tuning-status idle";
    stabilityBar.style.width = '0%';
    needleEl.style.transform = `rotate(0deg)`;
    needleEl.style.backgroundColor = 'var(--needle-color)';
    needleGlowEl.style.opacity = 0;
}

// --- Helpers (Math) ---

function detectNote(freq) {
    let closest = null;
    let minDiff = Infinity;

    for (const [note, data] of Object.entries(guitarStrings)) {
        if (freq >= data.min && freq <= data.max) {
            return { note, freq: data.freq };
        }
        const diff = Math.abs(freq - data.freq);
        if (diff < minDiff) {
            minDiff = diff;
            closest = { note, freq: data.freq };
        }
    }
    return closest;
}

function calculateCents(current, target) {
    return 1200 * Math.log2(current / target);
}

// --- Autocorrelation ---
function autoCorrelate(buf, sampleRate, precalcRMS) {
    // 1. RMS Check
    // If we passed RMS, use it, else calc
    let rms = precalcRMS;
    if (rms === undefined) {
        rms = 0;
        for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
        rms = Math.sqrt(rms / buf.length);
    }

    if (rms < config.silenceRMS) return -1; // Too quiet

    // 2. Windowing
    let r1 = 0, r2 = config.bufferSize - 1;
    const thres = 0.2;
    for (let i = 0; i < buf.length / 2; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
    for (let i = 1; i < buf.length / 2; i++) if (Math.abs(buf[config.bufferSize - i]) < thres) { r2 = config.bufferSize - i; break; }
    const buf2 = buf.slice(r1, r2);

    // 3. Autocorrelation
    const c = new Array(buf2.length).fill(0);
    for (let offset = 30; offset < 800; offset++) {
        let corr = 0;
        for (let i = 0; i < buf2.length - offset; i++) {
            corr += buf2[i] * buf2[i + offset];
        }
        c[offset] = corr;
    }

    // 4. Peak Finding
    let maxVal = 0;
    for (let i = 0; i < buf2.length; i++) maxVal += buf2[i] * buf2[i]; // Lag 0
    const peakThresh = maxVal * 0.8;

    let bestPeriod = -1;
    for (let i = 30; i < 799; i++) {
        if (c[i] > peakThresh && c[i] > c[i - 1] && c[i] > c[i + 1]) {
            bestPeriod = i;
            break;
        }
    }

    if (bestPeriod === -1) {
        let maxCorr = -1;
        for (let i = 30; i < 800; i++) {
            if (c[i] > maxCorr) {
                maxCorr = c[i];
                bestPeriod = i;
            }
        }
    }

    if (bestPeriod !== -1) {
        const prev = c[bestPeriod - 1] || 0;
        const next = c[bestPeriod + 1] || 0;
        const curr = c[bestPeriod];
        const shift = (prev - next) / (2 * (prev - 2 * curr + next));
        return sampleRate / (bestPeriod + shift);
    }
    return -1;
}

// Auto-start
window.addEventListener('DOMContentLoaded', () => {
    startTuner().then(() => {
        // If context was created but is suspended (autoplay policy), resume on first click
        if (audioContext && audioContext.state === 'suspended') {
            const resumeFn = () => {
                audioContext.resume();
                document.removeEventListener('click', resumeFn);
                document.removeEventListener('keydown', resumeFn);
                document.removeEventListener('touchstart', resumeFn);
            };
            document.addEventListener('click', resumeFn);
            document.addEventListener('keydown', resumeFn);
            document.addEventListener('touchstart', resumeFn);
        }
    });
});
