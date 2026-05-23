~setupClicks = {
    SynthDef(\clickBurst, { |out = 0, dur = 20, amp = 0.2,
                            rateStart = 2, ratePeak = 80, rateEnd = 0,
                            pitchStart = 800, pitchEnd = 5000|
        var rateEnv  = EnvGen.kr(Env([rateStart, ratePeak, rateEnd], [dur * 0.6, dur * 0.4], [4, -2]));
        var pitchEnv = EnvGen.kr(Env([pitchStart, pitchEnd], [dur], 3));
        var ampEnv   = EnvGen.kr(
            Env([0, 1, 1, 0], [dur * 0.3, dur * 0.4, dur * 0.3], \sine),
            doneAction: 2
        );

        var trig     = Impulse.ar(rateEnv);
        var ringTime = TRand.ar(0.001, 0.020, trig);
        var click    = Ringz.ar(trig, pitchEnv, ringTime, 0.5);
        var panned = Pan2.ar(click, LFNoise0.ar(rateEnv).range(-0.7, 0.7));
        var wet    = FreeVerb.ar(panned, mix: 0.25, room: 0.6, damp: 0.6);

        Out.ar(out, wet * ampEnv * amp);
    }).add;

    s.sync;

    Tdef(\clickBurstSpawner, {
        rrand(20.0, 60.0).wait;
        loop {
            var rateLocked = 0.4.coin;
            var ratePeak   = exprand(15.0, 100.0);
            var rateStart  = if(rateLocked) { ratePeak } { rrand(1.0, 5.0) };
            var rateEnd    = if(rateLocked) { ratePeak } { 0 };
            var pitchUp    = 0.7.coin;
            var pitchLow   = exprand(400.0, 1500.0);
            var pitchHigh  = exprand(2500.0, 6000.0);
            var pitchStart = if(pitchUp) { pitchLow } { pitchHigh };
            var pitchEnd   = if(pitchUp) { pitchHigh } { pitchLow };

            Synth(\clickBurst, [
                \dur,        rrand(12.0, 25.0),
                \amp,        rrand(0.15, 0.25),
                \rateStart,  rateStart,
                \ratePeak,   ratePeak,
                \rateEnd,    rateEnd,
                \pitchStart, pitchStart,
                \pitchEnd,   pitchEnd
            ], ~voiceGroup);

            rrand(120.0, 240.0).wait;
        }
    }).play;
};
