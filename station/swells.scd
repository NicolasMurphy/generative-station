~setupSwells = {
    var fxBus = Bus.audio(s, 2);

    SynthDef(\swellSine, { |freq = 440, amp = 0.04, atk = 3, rel = 5, out = 0|
        var env = EnvGen.kr(
            Env([0, 1, 0], [atk, rel], \sine),
            doneAction: 2
        );
        var sig = SinOsc.ar(freq) * env * amp;
        Out.ar(out, sig ! 2);
    }).add;

    SynthDef(\swellFx, { |in, out = 0|
        var dry       = In.ar(in, 2);
        var delayTime = LFNoise2.kr(0.1).range(0.15, 0.55);
        var baseFb    = LFNoise2.kr(0.08).range(0.30, 0.50);
        var jumpTrig  = Dust.kr(0.025);
        var jumpEnv   = EnvGen.kr(Env([0, 0.45, 0], [0.4, 2.0], \sine), jumpTrig);
        var fbAmt     = (baseFb + jumpEnv).clip(0, 0.95);
        var fb        = LocalIn.ar(2);
        var delayed   = DelayC.ar(dry + (fb * fbAmt), 1.0, delayTime);
        var mixed     = dry + (delayed * 0.45);
        var wet = FreeVerb.ar(
            mixed,
            mix:  LFNoise2.kr(0.07).range(0.35, 0.7),
            room: LFNoise2.kr(0.05).range(0.6, 0.9),
            damp: LFNoise2.kr(0.05).range(0.2, 0.6)
        );
        LocalOut.ar(LeakDC.ar(delayed).tanh);
        Out.ar(out, wet);
    }).add;

    s.sync;

    Synth(\swellFx, [\in, fxBus, \out, 0], ~fxGroup);

    Tdef(\swellSpawner, {
        var start = thisThread.seconds;
        loop {
            var elapsed = thisThread.seconds - start;
            var density = sin(elapsed * 2pi / 240) * 0.5 + 0.5;
            var waitMin = 0.3 + ((1 - density) * 2.5);
            var waitMax = 0.8 + ((1 - density) * 6.0);
            Synth(\swellSine, [
                \freq, exprand(200.0, 1000.0),
                \amp,  rrand(0.02, 0.05),
                \atk,  rrand(2.0, 6.0),
                \rel,  rrand(3.0, 8.0),
                \out,  fxBus
            ], ~voiceGroup);
            rrand(waitMin, waitMax).wait;
        }
    }).play;
};
