'use strict';
/* ═══════════════════════════════════════════════════════════════
   pdf-history.js — Undo/Redo command pattern for PDF editor
   ═══════════════════════════════════════════════════════════════ */

(function () {

class EditorHistory {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
    this.maxSize = 100;
    this.onChange = null; // callback: (canUndo, canRedo) => {}
  }

  execute(command) {
    command.execute();
    this.undoStack.push(command);
    if (this.undoStack.length > this.maxSize) this.undoStack.shift();
    this.redoStack = [];
    this._notify();
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    cmd.undo();
    this.redoStack.push(cmd);
    this._notify();
    return true;
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    cmd.execute();
    this.undoStack.push(cmd);
    this._notify();
    return true;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this._notify();
  }

  _notify() {
    if (this.onChange) this.onChange(this.canUndo, this.canRedo);
  }
}

// ── Command implementations ─────────────────────────────────────

class AddAnnotationCmd {
  constructor(store, annotation) {
    this.store = store;
    this.annotation = annotation;
  }
  execute() { this.store.add(this.annotation); }
  undo()    { this.store.remove(this.annotation.id); }
}

class RemoveAnnotationCmd {
  constructor(store, annotation) {
    this.store = store;
    this.annotation = annotation;
  }
  execute() { this.store.remove(this.annotation.id); }
  undo()    { this.store.add(this.annotation); }
}

class MoveAnnotationCmd {
  constructor(store, id, oldRect, newRect) {
    this.store = store;
    this.id = id;
    this.oldRect = { ...oldRect };
    this.newRect = { ...newRect };
  }
  execute() { this.store.updateRect(this.id, this.newRect); }
  undo()    { this.store.updateRect(this.id, this.oldRect); }
}

class ModifyAnnotationCmd {
  constructor(store, id, oldProps, newProps) {
    this.store = store;
    this.id = id;
    this.oldProps = { ...oldProps };
    this.newProps = { ...newProps };
  }
  execute() { this.store.updateProps(this.id, this.newProps); }
  undo()    { this.store.updateProps(this.id, this.oldProps); }
}

class BatchCmd {
  constructor(commands) { this.commands = commands; }
  execute() { this.commands.forEach(c => c.execute()); }
  undo()    { for (let i = this.commands.length - 1; i >= 0; i--) this.commands[i].undo(); }
}

// ── Exports ─────────────────────────────────────────────────────

window.PdfHistory = {
  EditorHistory,
  AddAnnotationCmd,
  RemoveAnnotationCmd,
  MoveAnnotationCmd,
  ModifyAnnotationCmd,
  BatchCmd,
};

})();
