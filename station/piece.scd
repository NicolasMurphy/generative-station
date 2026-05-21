(
s = Server.default;
s.options.numOutputBusChannels = 2;
s.options.numInputBusChannels = 0;
s.options.sampleRate = 48000;
s.options.blockSize = 64;
s.options.memSize = 8192 * 4;

s.waitForBoot({
    SynthDef(\sine, {
        var sig = SinOsc.ar(440) * 0.1;
        Out.ar(0, sig ! 2);
    }).add;
    s.sync;
    Synth(\sine);
    "[piece] sine running at 440 Hz".postln;
});
)
