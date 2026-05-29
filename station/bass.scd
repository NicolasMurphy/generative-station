~setupBass = {
    SynthDef(\bass, { |out = 0, dur = 30, amp = 0.3,
                      freqStart = 60, freqEnd = 20, preDelay = 0.04|
        var freqEnv = EnvGen.kr(Env([freqStart, freqEnd], [dur], \exp));
        var ampEnv  = EnvGen.kr(
            Env([0, 1, 1, 0], [dur * 0.15, dur * 0.7, dur * 0.15], \sine),
            doneAction: 2
        );

        var octaveAmpEnv  = EnvGen.kr(Env([0.7, 0.08], [dur * 0.15], \sine));
        var tritaveAmpEnv = EnvGen.kr(Env([0.5, 0.03], [dur * 0.12], \sine));

        var root    = SinOsc.ar(freqEnv);
        var octave  = SinOsc.ar(freqEnv * 2) * octaveAmpEnv;
        var tritave = SinOsc.ar(freqEnv * 3) * tritaveAmpEnv;

        var sum        = root + octave + tritave;
        var saturated  = (sum * 1.1).tanh;
        var verbWet    = FreeVerb.ar(saturated, mix: 1.0, room: 0.7, damp: 0.5);
        var preDelayed = DelayN.ar(verbWet, 0.2, preDelay);
        var verbed     = (saturated * 0.85) + (preDelayed * 0.15);
        var duck       = In.kr(~sidechainBus, 1);
        var sig        = verbed * ampEnv * amp * (1 - (duck * 0.7));

        Out.ar(out, sig ! 2);
    }).add;

    s.sync;

    Tdef(\bassSpawner, {
        rrand(30.0, 90.0).wait;
        loop {
            Synth(\bass, [
                \dur,       rrand(25.0, 40.0),
                \amp,       rrand(0.22, 0.35),
                \freqStart, exprand(50.0, 80.0),
                \freqEnd,   exprand(18.0, 28.0)
            ], ~voiceGroup);

            rrand(180.0, 420.0).wait;
        }
    }).play;
};
