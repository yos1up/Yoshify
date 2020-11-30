const USE_AUDIOWORKLET = true

const rhythmPattern = [
    {"inst": "low", "pos": 0},
    {"inst": "high", "pos": 0.5},
    {"inst": "high", "pos": 0.76},
]

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
function playSound(buffer, when) {
    /* デコード済音声バイナリデータ buffer を when[sec]（AudioContextのcurrentTimeなどで扱われる絶対時間）に再生する */
    let source = audioContext.createBufferSource()
    source.buffer = buffer
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
let waveBuffer = null

let playMetronome = false
chrome.extension.onRequest.addListener (
    function(request, sender, sendResponse) {
        playMetronome = request.isActive
        if (playMetronome) playSound(soundBuffers.yoshi)
        sendResponse({})
        return true
    }
)

let estimationResult = {
    "bpm": null,
    "beatReferenceTime": null,
    "bpmHistory": []
}

let analysisWorker = null

let audioContext = null
let audioContextSampleRate = null

// =========================================


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

function getRunningAudioContext(){
    /*
        audioContext.state === "running" な audioContext が
        得られたらそれを返す
        （ユーザがページ内で操作をすると得られるようになる）
    */
    return new Promise((resolve, reject) => {
        const handler = setInterval(()=>{
            const audioContext = new AudioContext()
            if (audioContext.state === "running"){
                clearInterval(handler)
                resolve(audioContext)
            }
        }, 1000)
    })
}

getRunningAudioContext().then((ac)=>{
    audioContext = ac
    audioContextSampleRate = audioContext.sampleRate
    waveBuffer = new RingBuffer(audioContextSampleRate * 5)

    loadSound(chrome.extension.getURL("../sounds/bongo_low.wav"), "low")
    loadSound(chrome.extension.getURL("../sounds/bongo_high.wav"), "high")
    loadSound(chrome.extension.getURL("../sounds/yoshi.wav"), "yoshi")

    // ScriptProcessorNode を用いる方針（非推奨，いずれは AudioWorklet へ移行が必要らしいが）
    // TODO: 16384設定（最大）でもSPNはかなり重い
    // AudioWorklet へ移行すべき → した (USE_AUDIOWORKLET == true で)
    const binWidthBySample = 16384

    let vs = document.getElementsByTagName("video")
    console.log(`number of video elements: ${vs.length}`)
    if (vs.length > 0){
        const track = audioContext.createMediaElementSource(vs[0])
        // TODO: もしかしてタブの音声出力全掴みできる？
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
            const processorPath = chrome.extension.getURL("src/recordingAudioWorklet.js")
            audioContext.audioWorklet.addModule(processorPath).then(() => {
                const awn = new AudioWorkletNode(audioContext, "recordingAudioWorklet")
                track.connect(awn)
                console.log("track -> awn")
                // awn は destination に繋がなくても動作してくれるようだ．素敵．
                track.connect(audioContext.destination)
                console.log("track -> destination")

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
            if (analysisWorker) analysisWorker.postMessage({wave, waveSampleRate, waveFinishedAt}) // WebWorker に移動したおかげで FFT が原因でメインスレッドの処理落ちすることはなくなった
        }

        console.log("start computing BPM")
        setInterval(computeBPM, 4000)
    } 

    fetch(chrome.extension.getURL("src/analysisWorker.js")).then((res) => res.text()).then((text)=>{
        analysisWorker = new Worker(createURLFromText(text))
        let debugKey = localStorage.save
        analysisWorker.onmessage = function (e){
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
                // const num = 11
                // console.log(`(median of last ${num} trials: ${getMedian(estimationResult.bpmHistory.slice(-num))})`)

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

    })       

})

function computeBPM2(wave, waveSampleRate, waveFinishedAt){
    if (wave.length === 0 || wave.reduce((x,y)=>x+y) === 0){
        estimationResult.bpm = null
        estimationResult.beatReferenceTime = null
        estimationResult.bpmHistory.push(null)
        return null
    }
    if (analysisWorker) analysisWorker.postMessage({wave, waveSampleRate, waveFinishedAt}) // WebWorker に移動したおかげで FFT が原因でメインスレッドの処理落ちすることはなくなった
}

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

