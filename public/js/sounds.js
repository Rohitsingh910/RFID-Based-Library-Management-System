/**
 * Sound Engine — Web Audio API based sound effects
 * No external files needed, pure synthesized sounds.
 */
const KioskSounds = {
    _ctx: null,

    _ensure() {
        if (!this._ctx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            this._ctx = new Ctx();
        }
        // Resume if suspended (browser policy)
        if (this._ctx.state === 'suspended') this._ctx.resume();
        return this._ctx;
    },

    /** Soft click for button presses */
    click() {
        const ctx = this._ensure();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sine';
        o.frequency.setValueAtTime(800, ctx.currentTime);
        o.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.08);
        g.gain.setValueAtTime(0.12, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
        o.start(); o.stop(ctx.currentTime + 0.08);
    },

    /** Happy ascending arpeggio for successful check-in */
    success() {
        const ctx = this._ensure();
        [523, 659, 784].forEach((freq, i) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.connect(g); g.connect(ctx.destination);
            o.type = 'sine';
            o.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.1);
            g.gain.setValueAtTime(0.1, ctx.currentTime + i * 0.1);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.1 + 0.2);
            o.start(ctx.currentTime + i * 0.1);
            o.stop(ctx.currentTime + i * 0.1 + 0.2);
        });
    },

    /** Low buzz for errors */
    error() {
        const ctx = this._ensure();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'square';
        o.frequency.setValueAtTime(220, ctx.currentTime);
        o.frequency.setValueAtTime(180, ctx.currentTime + 0.1);
        g.gain.setValueAtTime(0.08, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        o.start(); o.stop(ctx.currentTime + 0.25);
    },

    /** Celebration fanfare for "Done" */
    celebration() {
        const ctx = this._ensure();
        [523, 659, 784, 1047].forEach((freq, i) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.connect(g); g.connect(ctx.destination);
            o.type = 'sine';
            o.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.12);
            g.gain.setValueAtTime(0.12, ctx.currentTime + i * 0.12);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.3);
            o.start(ctx.currentTime + i * 0.12);
            o.stop(ctx.currentTime + i * 0.12 + 0.3);
        });
    }
};
