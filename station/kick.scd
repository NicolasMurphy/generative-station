~setupKick = {
    SynthDef(\kick, { |out = 0, amp = 0.1, bpm = 100,
                      freqStart = 85, freqEnd = 35,
                      sweepDur = 0.18, decay = 0.8,
                      lpf = 220, airAmp = 0.015,
                      verbMix = 0.18, preDelay = 0.06,
                      duckRelease = 0.22,
                      gate = 0, fadeTime = 30|
        var trig    = Impulse.kr(bpm / 60.0);
        // Window gate: smooth S-curve fade in/out controlled by .set(\gate, 0|1).
        // Scales both audio and sidechain so the pump fades alongside the kick.
        var fadeEnv = EnvGen.kr(Env.asr(fadeTime, 1, fadeTime, \sine), gate);
        var freqEnv = EnvGen.kr(
            Env([freqStart, freqEnd], [sweepDur], -4),
            trig
        );
        var ampEnv  = EnvGen.kr(
            Env.new([0, 1, 0], [0.018, decay], [-2, -3]),
            trig
        );
        // Sidechain duck envelope: fast snap to 1, smooth release back to 0.
        // Published to ~sidechainBus; voices attenuate by (1 - duck * depth).
        var duckEnv = EnvGen.kr(
            Env.new([0, 1, 0], [0.001, duckRelease], [-4, -4]),
            trig
        );
        var body       = LPF.ar(SinOsc.ar(freqEnv), lpf);
        var air        = HPF.ar(PinkNoise.ar(), 400) * airAmp;
        var dry        = (body + air) * ampEnv * amp;
        var verbWet    = FreeVerb.ar(dry, mix: 1.0, room: 0.75, damp: 0.5);
        var preDelayed = DelayN.ar(verbWet, 0.2, preDelay);
        var verbed     = (dry * (1 - verbMix)) + (preDelayed * verbMix);
        Out.kr(~sidechainBus, duckEnv * fadeEnv);
        Out.ar(out, (verbed * fadeEnv) ! 2);
    }).add;

    s.sync;

    "[kick] 4-on-the-floor at 100 bpm, window-gated".postln;
    ~kickSynth = Synth(\kick, [\out, ~masterBus, \gate, 0], ~voiceGroup);

    // Window scheduler: cycles of 20-40 min, each with a 5-10 min on-window
    // and the remainder off. .set(\gate, ...) drives the synth's internal
    // ASR fade so transitions are smooth (fadeTime seconds at each edge).
    Tdef(\kickWindow, {
        rrand(300.0, 900.0).wait;
        loop {
            var window = rrand(300.0, 600.0);
            var cycle  = rrand(1200.0, 2400.0);
            var gap    = (cycle - window).max(60.0);

            ("[kick] window open for " ++ window.round(1) ++ " s").postln;
            ~kickSynth.set(\gate, 1);
            window.wait;

            ("[kick] window closing, gap " ++ gap.round(1) ++ " s").postln;
            ~kickSynth.set(\gate, 0);
            gap.wait;
        };
    }).play;
};
