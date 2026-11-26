~setupCall = {
    var callBus = Bus.audio(s, 2);
    // When the call is next to be played, on Main.elapsedTime's clock. Never,
    // until there is a compound to call.
    var due = inf;

    // The same pure sine as the other pitched voices, struck softly and left
    // to ring.
    SynthDef(\callNote, { |freq = 440, amp = 0.03, atk = 0.015, rel = 3, pan = 0, out = 0|
        var env = EnvGen.kr(Env.perc(atk, rel, 1, -5), doneAction: 2);
        var sig = SinOsc.ar(freq) * env * amp;
        Out.ar(out, ~place.(sig, pan));
    }).add;

    // One echo that dies away, and a large room. Unlike the other voices'
    // delays nothing here regenerates: the call is the one thing the station
    // says plainly.
    SynthDef(\callFx, { |in, out = 0, echoTime = 0.44, echoFb = 0.3, preDelay = 0.06|
        var dry        = In.ar(in, 2);
        var fb         = LocalIn.ar(2);
        var echo       = DelayC.ar(dry + (fb * echoFb), 1.0, echoTime);
        var mixed      = dry + (echo * 0.35);
        var verbWet    = FreeVerb.ar(mixed, mix: 1.0, room: 0.85, damp: 0.4);
        var preDelayed = DelayN.ar(verbWet, 0.2, preDelay);
        var wet        = (mixed * 0.65) + (preDelayed * 0.35);
        LocalOut.ar(LeakDC.ar(echo));
        Out.ar(out, wet * (1 - (In.kr(~sidechainBus, 1) * 0.3)));
    }).add;

    s.sync;

    Synth(\callFx, [\in, callBus, \out, ~masterBus], ~fxGroup);

    // A station says what it is every so often. This one cannot say the name
    // of what is playing, but it can play it: the compound's strongest peaks
    // one at a time, strongest first, as single notes. Everything else the
    // pitched voices play is the whole spectrum at once, moved to a new pitch
    // every time; the call is always the same notes in the same order at the
    // same pitch, so that a compound has a tune of its own that comes round
    // again.
    //
    // Returns [frequency, strength from 0 to 1] for each note, five at most.
    //  - The compound's own frequencies, moved by whole octaves (so every
    //    interval is kept) until the strongest lies between 1000 and 2000 Hz.
    //    That is above the swells, which fill everything from 200 to 1000 Hz
    //    with the same sines: rendered an octave or two lower, at the pitch
    //    the compound came in, the call could not be told from them.
    //  - A peak within a quarter-tone of a note already in the call is that
    //    note again and is passed over: spectra are full of close neighbours
    //    (isotope peaks sit 1 Hz apart under the linear mapping).
    //  - A peak that the move leaves below 500 Hz or above 3200 is passed
    //    over.
    ~callPhrase = {
        var freqs = ~currentCompound.freqs;
        var amps = ~currentCompound.amps;
        var notes = [];
        if(freqs.notNil and: { freqs.notEmpty }) {
            var order = amps.order.reverse;  // strongest first
            var top = amps[order[0]];
            var shift = 1;
            while { (freqs[order[0]] * shift) >= 2000 } { shift = shift / 2 };
            while { (freqs[order[0]] * shift) < 1000 } { shift = shift * 2 };
            order.do { |i|
                var f = freqs[i] * shift;
                var inRange = (f >= 500) and: { f <= 3200 };
                var fresh = notes.every { |n| (f / n[0]).log2.abs > (1 / 24) };
                if(inRange and: { fresh and: { notes.size < 5 } }) {
                    notes = notes.add([f, amps[i] / top]);
                };
            };
        };
        notes
    };

    // Plays the call. To be called from inside a routine: it waits between
    // the notes. A weaker peak is a quieter and shorter note and is followed
    // sooner, so the call falls away as it goes, like something set down.
    // Quiet peaks are lifted (as in the plucks' cascade) or they would not be
    // heard as notes at all. Low notes lean left and high ones right.
    //
    // It is meant to be quiet and clear rather than loud. Rendered in the
    // whole piece over a dense compound, a note reads -41 dB in the band it
    // sounds in (1.3 to 1.9 kHz over 0.2 s), where the mix as a whole reads
    // -32 dB and the loudest thing that otherwise passes through that band,
    // a pluck or a sweep, -42 dB.
    ~playCall = {
        var notes = [];
        try { notes = ~callPhrase.() } { |err|
            ("[call] skipped: " ++ err.errorString).postln;
        };
        if(notes.notEmpty) {
            var level = rrand(0.022, 0.028);
            var pitches = notes.collect { |n| n[0].log2 };
            var lo = pitches.minItem;
            var hi = pitches.maxItem;
            notes.do { |n, i|
                ~spawn.(\call, {
                    Synth(\callNote, [
                        \freq, n[0],
                        \amp,  level * (n[1] ** 0.3),
                        \rel,  2.2 + (1.4 * n[1].sqrt),
                        \pan,  if(hi > lo) { pitches[i].linlin(lo, hi, -0.5, 0.5) } { 0 },
                        \out,  callBus
                    ], ~voiceGroup);
                });
                (0.32 + (0.5 * n[1].sqrt)).wait;
            };
        };
    };

    // piece.scd calls this when a new compound has been taken up: its call is
    // the first thing heard of it, a moment after it arrives. That includes
    // the compound the picker sends again after the station has restarted.
    ~announceCompound = {
        var notes = [];
        try { notes = ~callPhrase.() };
        ("[call] " ++ notes.collect({ |n| n[0].round(0.1) }).join(", ") ++ " Hz").postln;
        due = Main.elapsedTime + 2.5;
    };

    // And it comes round again every 8 to 16 minutes for as long as the
    // compound stays.
    Tdef(\callSpawner, {
        loop {
            if(Main.elapsedTime >= due) {
                due = Main.elapsedTime + (rrand(8.0, 16.0) * 60);
                ~playCall.();
            };
            0.5.wait;
        }
    }).play;
};
