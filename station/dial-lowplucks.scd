// Standalone dial-in boot for lowPlucks. Run locally (scide, or
// `sclang dial-lowplucks.scd`) to hear lowPlucks ALONE while tuning the sound.
// Touches nothing else: piece.scd, swells.scd, and the live station are
// unaffected. Once dialed in, lowPlucks gets wired into piece.scd with the
// ~20-min swell<->lowPluck switch.
(
s = Server.default;
s.options.numOutputBusChannels = 2;
s.options.numInputBusChannels = 0;
s.options.sampleRate = 48000;
s.options.blockSize = 64;
s.options.memSize = 8192 * 4;

s.waitForBoot({
    var here = thisProcess.nowExecutingPath.dirname;

    ~voiceGroup = Group.new;
    ~fxGroup    = Group.after(~voiceGroup);
    ~sidechainBus = Bus.control(s, 1);  // stays 0 with no kick — no ducking

    // nil freqs -> lowPlucks uses its fallback random range. To audition chord
    // mode, set freqs/amps to test arrays, e.g.:
    //   freqs: [220, 277, 330, 440], amps: [1, 0.8, 0.6, 0.5]
    ~currentCompound = (name: nil, accession: nil, algorithm: nil, freqs: nil, amps: nil);

    (here +/+ "lowplucks.scd").load;
    ~setupLowPlucks.();

    "[dial] lowPlucks solo running".postln;
});
)
