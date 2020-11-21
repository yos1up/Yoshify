const USE_AUDIOWORKLET = true

const rhythmPattern = [
    {"inst": "low", "pos": 0},
    {"inst": "high", "pos": 0.5},
    {"inst": "high", "pos": 0.76},
]

let playMetronome = false
chrome.extension.onRequest.addListener (
    function(request, sender, sendResponse) {
        playMetronome = request.isActive
        if (playMetronome) playSound(soundBuffers.yoshi)
    }
)


function argmax(ary){
    let maxi = -Infinity, argmaxi = -1
    for(let i=0;i<ary.length;i++) if (maxi < ary[i]) {maxi = ary[i]; argmaxi = i}
    return argmaxi
}

function autoDownload(filename, contentString){
    download(filename, createURLFromText(contentString))
}
function createURLFromText(contentString) {
    let bom = new Uint8Array([0xef, 0xbb, 0xbf])
    let url = URL.createObjectURL(
        new Blob([bom, contentString], { type: 'text/plain;charset=UTF-8' })
    )
    return url
}
function download(filename, url){
    let a = document.createElement('a')
    document.body.appendChild(a)
    a.download = filename
    a.href = url
    a.click()
    document.body.removeChild(a)
}

const audioContext = new AudioContext()
const audioContextSampleRate = audioContext.sampleRate

const soundBuffers = {}
function loadSound(url, name) {
    let request = new XMLHttpRequest();
    request.open('GET', url, true);
    request.responseType = 'arraybuffer'
    // Decode asynchronously
    request.onload = function() {
        audioContext.decodeAudioData(request.response, function(buffer) {
            soundBuffers[name] = buffer
        }, ()=>{console.log("decode failed")})
    }
    request.send()
}
loadSound(chrome.extension.getURL("../sounds/bongo_low.wav"), "low")
loadSound(chrome.extension.getURL("../sounds/bongo_high.wav"), "high")
loadSound(chrome.extension.getURL("../sounds/yoshi.wav"), "yoshi")


function playSound(buffer, when) {
    /* デコード済音声バイナリデータ buffer を when[sec]（AudioContextのcurrentTimeなどで扱われる絶対時間）に再生する */
    let source = audioContext.createBufferSource()
    source.buffer = buffer
    let gainNode = audioContext.createGain()
    /*
    source.connect(gainNode)
    gainNode.connect(audioContext.destination)   
    gainNode.gain.value = 0.5
    */
    source.connect(audioContext.destination)
    source.start(when)
}

class RingBuffer{
    constructor(capacity){
        this.data = new Array(capacity)
        this.capacity = capacity
        this.length = 0
        this.start = 0
        this.end = 0
        this.updatedAt = null
    }
    push(x){
        this.data[this.end] = x
        if (this.length > 0 && this.start == this.end) this.start = (this.start + 1) % this.capacity
        this.end = (this.end + 1) % this.capacity
        this.length = Math.min(this.length + 1, this.capacity)
    }
    slice(s, e){
        if (typeof s === "undefined") s = 0
        if (typeof e === "undefined") e = this.length
        e = Math.min(e, this.length)
        s = Math.max(0, Math.min(s, e))
        const n = e - s
        s = (s + this.start) % this.capacity
        if (s + n <= this.length) return this.data.slice(s, s + n)
        return this.data.slice(s).concat(this.data.slice(0, n - this.length + s))
    }
}
const waveBuffer = new RingBuffer(audioContextSampleRate * 5)

// ScriptProcessorNode を用いる方針（非推奨，いずれは AudioWorklet へ移行が必要らしいが）
// TODO: 16384設定（最大）でもSPNはかなり重い
// AudioWorklet へ移行すべきか．あるいは destination へのルートと spn へのルートを並列にできないか？
const binWidthBySample = 16384

let vs = document.getElementsByTagName("video")
if (vs.length > 0){
    const track = audioContext.createMediaElementSource(vs[0])
    if (!USE_AUDIOWORKLET){
        const spn = audioContext.createScriptProcessor(binWidthBySample, 1, 1)
        // 生波形をバッファに貯めていく
        spn.onaudioprocess = function(e) {
            var inputBuffer = e.inputBuffer
            var outputBuffer = e.outputBuffer
            for (var channel = 0; channel < outputBuffer.numberOfChannels; channel++) {
                var inputData = inputBuffer.getChannelData(channel);
                var outputData = outputBuffer.getChannelData(channel);
                for (var sample = 0; sample < inputBuffer.length; sample++) {
                    outputData[sample] = inputData[sample];
                    if (channel==0) waveBuffer.push(inputData[sample])
                    // TODO: 片方チャンネルのみになってる
                }
            }
            waveBuffer.updatedAt = audioContext.currentTime
        }
        track.connect(spn)
        spn.connect(audioContext.destination)
    }else{
        const processorPath = chrome.extension.getURL("src/my-processor.js")
        audioContext.audioWorklet.addModule(processorPath).then(() => {
            const awn = new AudioWorkletNode(audioContext, "my-processor")
            track.connect(awn)
            // awn は destination に繋がなくても動作してくれるようだ．素敵．
            track.connect(audioContext.destination)

            awn.port.onmessage = (e) => {
                const {wave, waveSampleRate, waveFinishedAt} = e.data
                // const waveBuffer = e.data
                // const wave = waveBuffer.slice()
                /*
                const waveFinishedAt = waveBuffer.updatedAt
                waveBuffer.slice = RingBuffer.prototype.slice
                const wave = waveBuffer.slice()
                */
                computeBPM2(wave, waveSampleRate, waveFinishedAt)
            }
        })
    }
}

function computeBPM2(wave, waveSampleRate, waveFinishedAt){
    if (wave.length === 0 || wave.reduce((x,y)=>x+y) === 0){
        estimationResult.bpm = null
        estimationResult.beatReferenceTime = null
        estimationResult.bpmHistory.push(null)
        return null
    }
    worker.postMessage({wave, waveSampleRate, waveFinishedAt}) // WebWorker に移動したおかげで FFT が原因でメインスレッドの処理落ちすることはなくなった
}

if (!USE_AUDIOWORKLET){
    function computeBPM(){
        const wave = waveBuffer.slice()
        const waveSampleRate = audioContextSampleRate
        const waveFinishedAt = waveBuffer.updatedAt
        if (wave.length === 0 || wave.reduce((x,y)=>x+y) === 0){
            estimationResult.bpm = null
            estimationResult.beatReferenceTime = null
            estimationResult.bpmHistory.push(null)
            return null
        }
        worker.postMessage({wave, waveSampleRate, waveFinishedAt}) // WebWorker に移動したおかげで FFT が原因でメインスレッドの処理落ちすることはなくなった
    }

    console.log("start computing BPM")
    setInterval(computeBPM, 4000)
}


const workerJS = `
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
`

let estimationResult = {
    "bpm": null,
    "beatReferenceTime": null,
    "bpmHistory": []
}

let worker = new Worker(createURLFromText(workerJS))
let debugKey = localStorage.save
worker.onmessage = function (e){
    const {bpmCandidates, onSignal, onSignalSamplingRate, waveFinishedAt, onPowerSpect, wave, waveSampleRate, stfts} = e.data
    if (bpmCandidates.length > 0) {
        const argmaxi = argmax(bpmCandidates.map(_ => _.peakValue))
        const bpm = bpmCandidates[argmaxi].BPM
        console.log("estimated BPM: " + bpm)


        //拍タイミング推定
        const peakOffset = findPeakOffset(onSignal, onSignalSamplingRate * 60 / bpm)
        const waveStartedAt = waveFinishedAt - wave.length / waveSampleRate
        // const beatReferenceTime = waveFinishedAt - (onSignal.length - peakOffset) / onSignalSamplingRate
        const beatReferenceTime = waveStartedAt + peakOffset / onSignalSamplingRate

        estimationResult.bpm = bpm
        estimationResult.beatReferenceTime = beatReferenceTime
        estimationResult.bpmHistory.push(bpm)
        const num = 11
        console.log(`(median of last ${num} trials: ${getMedian(estimationResult.bpmHistory.slice(-num))})`)

        // デバッグ用
        if (localStorage.save != debugKey){
            debugKey = localStorage.save
            autoDownload("snapshot.txt", JSON.stringify({
                bpmCandidates, onSignal, onSignalSamplingRate, waveFinishedAt, onPowerSpect, wave,
                bpm, peakOffset, beatReferenceTime, 
                waveSampleRate, stfts
            }))
        }
    }
}

// メトロノーム用
let lastScheduledTime = null
function setMetronomeSchedule(){
    if (playMetronome){
        const {bpm, beatReferenceTime} = estimationResult
        if (bpm === null || beatReferenceTime === null){
            return
        }
        const beatIntervalTime = 60 / bpm
        // audioContext.currentTime 以降 400ms の間で，beatReferenceTime + i * beatIntervalTime と表されるもののうち
        // lastScheduledTime 以降であるものを登録する．
        const currentTime = audioContext.currentTime
        const seq = generateTrimmedArithmeticSequence(
            beatReferenceTime,
            beatIntervalTime,
            currentTime,
            currentTime + 0.4 // 0.4 秒未来までのメトロノームを登録する
        ).filter(_ => (lastScheduledTime === null) || (lastScheduledTime + 0.2 < _))
        for (let s of seq){
            for (let note of rhythmPattern){
                playSound(soundBuffers[note.inst], s + note.pos * beatIntervalTime)
            }
        }
        if (seq.length > 0) lastScheduledTime = Math.max(...seq)
    }
}
setInterval(setMetronomeSchedule, 250)

function findPeakOffset(ary, interval){
    // ary[i + n * interval] (nは添字が有効な範囲で整数全体を動く) の平均が最大となるような i を求める．
    // ただし interval は整数とは限らない．中途半端な index に対しては ary を線形補完して計算する．
    // TODO: 遅い場合は高速化
    let maxi = -Infinity
    let argmaxi = -1
    for(let i=0;i<ary.length;i++){
        let numer = 0
        let denom = 0
        const seq = generateTrimmedArithmeticSequence(i, interval, 0, ary.length-1)
        for(let s of seq){
            const x = lerp(ary, s)
            if (x !== null){
                numer += x
                denom++
            }
        }
        const ave = numer / denom
        if (maxi < ave) {
            maxi = ave
            argmaxi = i
        }
    }
    return argmaxi
}

function lerp(ary, i){
    if (i < 0 || ary.length - 1 < i) return null
    if (i == ary.length - 1) return ary[ary.length - 1]
    const n = Math.floor(i)
    const r = i - n
    return ary[n] * (1 - r) + ary[n+1] * r
}

function generateTrimmedArithmeticSequence(ref, diff, mini, maxi){
    /* 無限等差数列 (ref + n * diff)_{n in Z} を区間 [mini, maxi] で切り取ったものを Array として返す
    diff は非ゼロとする．diffが正なら昇順，負なら降順のArrayが返る．*/
    if (diff < 0) return generateTrimmedArithmeticSequence(ref, -diff, mini, maxi).reverse()
    let nMin = Math.ceil((mini - ref) / diff)
    let nMax = Math.floor((maxi - ref) / diff)
    return range(nMin, nMax+1).map(_ => ref + _ * diff)
}

function range(s, e){
    /* [s, s+1, ..., e-1] */
    if (s >= e) return []
    return [...Array(e - s).keys()].map(_ => s + _)
}

function getMedian(ary){
    const sorted = ary.filter(_ => typeof _ === "number").sort()
    if (sorted.length === 0) return null
    const len = sorted.length
    if (len % 2){
        return sorted[(len - 1)/ 2]
    } else {
        return (sorted[len / 2 - 1] + sorted[len / 2]) / 2
    }
}






