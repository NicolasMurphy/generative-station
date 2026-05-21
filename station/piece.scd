(
s = Server.default;
s.options.numOutputBusChannels = 2;
s.options.numInputBusChannels = 0;
s.options.sampleRate = 48000;
s.options.blockSize = 64;
s.options.memSize = 8192 * 4;

s.waitForBoot({
    var fxBus, voiceGroup, fxGroup;

    fxBus = Bus.audio(s, 2);

    SynthDef(\swellSine, { |freq = 440, amp = 0.04, atk = 3, rel = 5, out = 0|
        var env = EnvGen.kr(
            Env([0, 1, 0], [atk, rel], \sine),
            doneAction: 2
        );
        var sig = SinOsc.ar(freq) * env * amp;
        Out.ar(out, sig ! 2);
    }).add;

    SynthDef(\fx, { |in, out = 0|
        var dry = In.ar(in, 2);
        var delayTime = LFNoise2.kr(0.1).range(0.15, 0.55);
        var delayed = CombC.ar(dry, 1.0, delayTime, LFNoise2.kr(0.05).range(2.0, 6.0));
        var mixed = dry + (delayed * 0.45);
        var wet = FreeVerb.ar(
            mixed,
            mix:  LFNoise2.kr(0.07).range(0.35, 0.7),
            room: LFNoise2.kr(0.05).range(0.6, 0.9),
            damp: LFNoise2.kr(0.05).range(0.2, 0.6)
        );
        Out.ar(out, wet);
    }).add;

    s.sync;

    voiceGroup = Group.new;
    fxGroup = Group.after(voiceGroup);
    Synth(\fx, [\in, fxBus, \out, 0], fxGroup);

    Tdef(\spawner, {
        loop {
            Synth(\swellSine, [
                \freq, exprand(200.0, 1000.0),
                \amp,  rrand(0.02, 0.05),
                \atk,  rrand(2.0, 6.0),
                \rel,  rrand(3.0, 8.0),
                \out,  fxBus
            ], voiceGroup);
            rrand(0.15, 0.6).wait;
        }
    }).play;

    "[piece] sine cloud running (200-1000 Hz)".postln;
});
)
