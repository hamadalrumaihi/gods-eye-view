import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { VisualSettings } from './visualSettings.js';
import { StyleManager } from './applicationShell.js';
import { enter, exit } from './cockpitTrackingController.js';

/** A button with the class and attribute state the sync paths write. */
function button(extra = {}) {
  const classes = new Set();
  return {
    attributes: new Map(),
    dataset: {},
    classList: {
      toggle: (name, enabled) =>
        enabled ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
    get pressed() {
      return this.getAttribute('aria-pressed');
    },
    get active() {
      return this.classList.contains('active');
    },
    ...extra,
  };
}

test('every style button reports aria-pressed matching its active class after a style change', () => {
  const saved = globalThis.document;
  const styles = [
    'normal',
    'retro',
    'surveillance',
    'thermal',
    'anime',
    'noir',
    'snow',
  ];
  const buttons = styles.map((style) => {
    const btn = button();
    btn.dataset.style = style;
    return btn;
  });
  globalThis.document = { querySelectorAll: () => buttons };
  try {
    for (const style of ['retro', 'snow', 'normal']) {
      VisualSettings.prototype._syncStyleButtons.call({}, style);
      for (const btn of buttons) {
        assert.equal(btn.active, btn.dataset.style === style);
        assert.equal(btn.pressed, String(btn.active));
      }
    }
  } finally {
    globalThis.document = saved;
  }
});

test('HUD, Bloom and Sharpen toggles keep aria-pressed in step with their active class', () => {
  const hudBtn = button();
  const hud = { visible: false };
  const hudOwner = {
    _hudBtn: hudBtn,
    hud,
    _hudLayoutRow: null,
    _scheduleAdaptivePanelLayout() {},
  };
  for (const visible of [true, false, true]) {
    hud.visible = visible;
    VisualSettings.prototype._updateHudButtonState.call(hudOwner);
    assert.equal(hudBtn.active, visible);
    assert.equal(hudBtn.pressed, String(visible));
  }

  const row = button();
  const effects = { bloom: false, sharpen: false };
  const owner = {
    services: { governorRequestRender() {} },
    _visualEffects: {
      setBloomEnabled: (value) => (effects.bloom = value),
      setSharpenEnabled: (value) => (effects.sharpen = value),
    },
    get bloomEnabled() {
      return effects.bloom;
    },
    get sharpenEnabled() {
      return effects.sharpen;
    },
    _syncBloomStageEnabled() {},
    _bloomBtn: button(),
    _bloomSliderRow: row,
    _applyBloomIntensity() {},
    _getBloomIntensity: () => 0.5,
    _sharpenBtn: button(),
    _sharpenSliderRow: row,
    _sharpenSlider: null,
    _syncShareState() {},
    _layoutRightPanels() {},
  };
  for (const enabled of [true, false]) {
    VisualSettings.prototype._setBloomEnabled.call(owner, enabled);
    assert.equal(owner._bloomBtn.active, enabled);
    assert.equal(owner._bloomBtn.pressed, String(enabled));
    VisualSettings.prototype._setSharpenEnabled.call(owner, enabled);
    assert.equal(owner._sharpenBtn.active, enabled);
    assert.equal(owner._sharpenBtn.pressed, String(enabled));
  }
});

test('Clean UI reports aria-pressed as it toggles the body class', () => {
  const saved = globalThis.document;
  const bodyClasses = new Set();
  globalThis.document = {
    body: {
      classList: {
        contains: (name) => bodyClasses.has(name),
        toggle: (name, enabled) =>
          enabled ? bodyClasses.add(name) : bodyClasses.delete(name),
      },
    },
  };
  try {
    const owner = { _cleanViewBtn: button(), _scheduleLeftPanelLayout() {} };
    StyleManager.prototype.toggleCleanView.call(owner);
    assert.equal(bodyClasses.has('ui-clean-view'), true);
    assert.equal(owner._cleanViewBtn.active, true);
    assert.equal(owner._cleanViewBtn.pressed, 'true');
    StyleManager.prototype.toggleCleanView.call(owner, false);
    assert.equal(owner._cleanViewBtn.active, false);
    assert.equal(owner._cleanViewBtn.pressed, 'false');
  } finally {
    globalThis.document = saved;
  }
});

test('the recording HUD sync writes aria-pressed beside the active class', () => {
  const source = readFileSync(
    new URL('./recordingControls.js', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /this\._hudBtn\.classList\.toggle\('active', this\.hud\.visible\);\s*this\._hudBtn\.setAttribute\(\s*'aria-pressed',\s*String\(!!this\.hud\.visible\),?\s*\);/,
  );
});

/** Cockpit entry/exit over a document whose focus can be observed. */
function cockpit({ entryVisibleOnExit = true } = {}) {
  const saved = {
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
  };
  class FakeElement {
    constructor(id) {
      this.id = id;
      this.hidden = false;
      this.isConnected = true;
      this.focusCalls = [];
      const classes = new Set();
      this.classList = {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      };
      this.style = { removeProperty() {} };
    }
    focus(options) {
      this.focusCalls.push(options);
      document.activeElement = this;
    }
  }
  const hud = new FakeElement('cockpit-hud');
  const entry = new FakeElement('cockpit-entry');
  const canvas = new FakeElement('canvas');
  const container = new FakeElement('cesiumContainer');
  const mapViewButton = new FakeElement('map-view-switch');
  const document = {
    activeElement: entry,
    body: new FakeElement('body'),
    getElementById: (id) => (id === 'cesiumContainer' ? container : null),
  };
  globalThis.document = document;
  globalThis.HTMLElement = FakeElement;
  const entity = { position: {}, show: true };
  const owner = {
    destroyed: false,
    active: false,
    isEntryAllowed: () => true,
    readAircraftInfo: () => ({ callsign: 'TEST1', track: 90 }),
    viewer: {
      trackedEntity: entity,
      camera: { cancelFlight() {} },
      scene: { screenSpaceCameraController: { enableInputs: true } },
      entities: { contains: () => true },
      canvas,
    },
    services: { holdContinuousRender() {}, releaseContinuousRender() {} },
    onCameraTakeover: null,
    entry,
    tr3bToggle: null,
    mapViewButton,
    resetGlobeButton: null,
    hud,
    signalStream: null,
    route: null,
    signalItems: [],
    signalSignatures: new Set(),
    visionMode: 'optical',
    trackedEntityWasShown: true,
    regionalBriefAbort: null,
    regionalBriefRequestToken: 0,
    restoreTrackingFrame: () => false,
    showBriefPage() {},
    startBriefRotation() {},
    stopBriefRotation() {},
    pushCockpitSignal() {},
    updateHud() {},
    setVisionMode() {},
    scheduleContextLayout() {},
    dispatchCockpitModeChanged() {},
    clearPredictiveRoute() {},
    syncEntry() {
      entry.hidden = !entryVisibleOnExit;
    },
  };
  return {
    owner,
    document,
    hud,
    entry,
    canvas,
    mapViewButton,
    restore() {
      Object.assign(globalThis, saved);
    },
  };
}

test('entering Cockpit focuses the Cockpit HUD and leaving returns focus to the COCKPIT entry', () => {
  const f = cockpit();
  try {
    assert.equal(enter.call(f.owner), true);
    assert.equal(f.document.activeElement, f.hud);
    assert.equal(f.hud.hidden, false, 'the HUD is shown before it is focused');
    assert.deepEqual(f.hud.focusCalls, [{ preventScroll: true }]);
    assert.deepEqual(f.mapViewButton.focusCalls, []);
    assert.equal(exit.call(f.owner), true);
    assert.equal(f.document.activeElement, f.entry);
  } finally {
    f.restore();
  }
});

test('leaving Cockpit with no visible entry control hands focus to the map', () => {
  const f = cockpit({ entryVisibleOnExit: false });
  try {
    enter.call(f.owner);
    exit.call(f.owner);
    assert.equal(f.document.activeElement, f.canvas);
    assert.equal(f.entry.focusCalls.length, 0);
  } finally {
    f.restore();
  }
});

test('both dialogs make their siblings inert while open and release them on close', () => {
  for (const file of ['../firstRunExperience.js', '../keySetup.js']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(
      source,
      /inertSiblings,?\s*\} from '\.\/ui\/surfaceKeyboard\.js'/,
    );
    assert.match(
      source,
      /root\.hidden = false;[\s\S]{0,160}releaseInert = inertSiblings\(root\);/,
    );
    assert.ok(
      (source.match(/releaseInert\(\);/g) || []).length >= 2,
      `${file} releases on close and on teardown`,
    );
  }
});
