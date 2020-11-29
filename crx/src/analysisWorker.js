let showDebugInfo = true
function computeBPM(data){
    const {waveSampleRate, wave, waveFinishedAt} = data
    // 1. STFTする
    // 2. 発音タイミングを抽出する
    // 3. その時間挙動を FFT する
    const targetWindowSecondOfSTFT = 0.025
    const binSample = findNearestPowerOf2(waveSampleRate * targetWindowSecondOfSTFT)
    const stfts = []
    // i ステップ目で，元の wave の [i * binSample - binSample/2, i * binSample + binSample/2) サンプルを
    // FFT にかけたい．
    const wavePadded = Array(binSample/2).fill(0).concat(wave).concat(Array(binSample/2).fill(0))
    for(let i=0;i<wave.length;i+=binSample){
        let wavelet = wavePadded.slice(i, i + binSample)
        // wavelet = padZero(wavelet, binSample)
        stfts.push(getPower(fft1(wavelet)))
    }
    // 2
    const lpFreq = 300, hpFreq = 50000 // 低音域と高音域だけあてにする
    const filteredIndices = [...Array(binSample).keys()].filter(i => i/binSample * waveSampleRate < lpFreq || hpFreq < i/binSample * waveSampleRate)
    let onSignal = [...Array(stfts.length - 1).keys()].map(i => filteredIndices.map(j => Math.max(stfts[i+1][j] - stfts[i][j], 0)).reduce((x,y) => x + y))
    // onSignal = onSignal.map(Math.log1p) // TODO: log1pは妥当か？
    const onSignalSamplingRate = waveSampleRate / binSample
    // 3
    const targetBPMResolution = 0.1 // BPM の目標解像度（indexToBPMCoeff がこれくらいの値になって欲しい） 
    const onSignalPaddedLength = findNearestPowerOf2(60 * waveSampleRate / binSample / targetBPMResolution)
    const onSignalPadded = padZero(onSignal, onSignalPaddedLength)
    const onSpect = fft1(onSignalPadded)
    const onPowerSpect = getPower(onSpect)
    const indexToBPMCoeff = 60 * waveSampleRate / onSignalPadded.length / binSample

    if (showDebugInfo){
        console.log({binSample, onSignalPaddedLength})
        showDebugInfo = false
    }

    const peakIndex = findPeak(onPowerSpect, Math.floor(84.5 / indexToBPMCoeff), Math.ceil(200.5 / indexToBPMCoeff))
    const bpmCandidates = peakIndex.map(i => ({
        "BPM": indexToBPMCoeff * i,
        "peakValue": onPowerSpect[i],
        "curvature": onPowerSpect[i] - 0.5 * (onPowerSpect[i-1] + onPowerSpect[i+1])
    }))
    return {bpmCandidates, onSignal, onSignalSamplingRate, waveFinishedAt, onPowerSpect, wave, waveSampleRate, stfts}
}

function findPeak(ary, start, end){
    start = Math.max(0, start)
    end = Math.min(ary.length, end)
    let ret = null, maxi = -Infinity
    for(let i=start;i<end;i++){
        if (maxi < ary[i]) {
            maxi = ary[i]
            ret = i
        }
    }
    let ret2 = []
    for(let i=start;i<end;i++){
        if (0 < i && i + 1 < ary.length && ary[i-1] <= ary[i] && ary[i] >= ary[i+1]) ret2.push(i)
    }
    return ret2
}

// ====================== FFT ======================
// https://qiita.com/bellbind/items/ba7aa07f6c915d400000
function expi(theta) {return [Math.cos(theta), Math.sin(theta)];}
function iadd([ax, ay], [bx, by]) {return [ax + bx, ay + by];}
function isub([ax, ay], [bx, by]) {return [ax - bx, ay - by];}
function imul([ax, ay], [bx, by]) {return [ax * bx - ay * by, ax * by + ay * bx];}
function isum(cs) {return cs.reduce((s, c) => iadd(s, c), [0, 0]);}
function revBit(k, n) {
    let r = 0;
    for (let i = 0; i < k; i++) r = (r << 1) | ((n >>> i) & 1);
    return r;
}
function fftin1(c, T, N) {
    const k = Math.log2(N);
    const rec = c.map((_, i) => c[revBit(k, i)]);
    for (let Nh = 1; Nh < N; Nh *= 2) {
        T /= 2;
        for (let s = 0; s < N; s += Nh * 2) {
            for (let i = 0; i < Nh; i++) {
                const l = rec[s + i], re = imul(rec[s + i + Nh], expi(T * i));
                [rec[s + i], rec[s + i + Nh]] = [iadd(l, re), isub(l, re)];
            }
        }
    }
    return rec;
}
function fft1(f) {
    /* [[re, im], ...] => [[re, im], ...] array length must be power of 2 */
    f = f.map(e => (typeof e[0] === "undefined") ? [e, 0] : e) // 実数は複素数に
    const N = f.length, T = -2 * Math.PI;
    return fftin1(f, T, N);
}
function ifft1(F) {
    /* [[re, im], ...] => [[re, im], ...] array length must be power of 2 */
    F = F.map(e => (typeof e[0] === "undefined") ? [e, 0] : e) // 実数は複素数に
    const N = F.length, T = 2 * Math.PI;
    return fftin1(F, T, N).map(([r, i]) => [r / N, i / N]);
}
function padZero(ary, len){
    if (typeof len === "undefined"){
        len = 1
        while(len < ary.length) len <<= 1
    }
    return ary.concat(Array(len - ary.length).fill(0))
}
function getPower(cplxAry){
    return cplxAry.map(e => e[0]*e[0] + e[1]*e[1])
}
// ====================== FFT ======================

function findNearestPowerOf2(x){
    return 1 << Math.round(Math.log2(x))
}

onmessage = function(e) {postMessage(computeBPM(e.data))}