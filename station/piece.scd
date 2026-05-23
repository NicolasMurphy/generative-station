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

    // Current compound, populated by /compound OSC messages from the picker
    // sidecar. Starts nil so voices fall back to their original random ranges.
    ~currentCompound = (
        name: nil,
        accession: nil,
        algorithm: nil,
        freqs: nil,
        amps: nil
    );

    // Listen for compound updates from the picker sidecar (port 57120).
    // Message: [name, accession, algorithm, nPeaks, freq1..N, amp1..N]
    OSCdef(\compound, { |msg|
        var name = msg[1].asString;
        var accession = msg[2].asString;
        var algorithm = msg[3].asString;
        var n = msg[4].asInteger;
        var freqs = msg[(5..(4+n))];
        var amps = msg[((5+n)..(4+(2*n)))];
        ~currentCompound = (
            name: name,
            accession: accession,
            algorithm: algorithm,
            freqs: freqs,
            amps: amps
        );
        ("[piece] compound: " ++ name ++ " (" ++ n ++ " peaks)").postln;
    }, "/compound");

    (here +/+ "swells.scd").load;
    (here +/+ "plucks.scd").load;
    (here +/+ "clicks.scd").load;
    (here +/+ "sweeps.scd").load;
    (here +/+ "bass.scd").load;

    ~setupSwells.();
    ~setupPlucks.();
    ~setupClicks.();
    ~setupSweeps.();
    ~setupBass.();

    "[piece] all elements running".postln;
});
)
