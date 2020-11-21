import matplotlib.pyplot as plt
import numpy as np

if 1:
    with open("onPowerSpect (2).txt", "r", encoding='utf_8_sig') as f:
        data = f.read()

    ary = np.array(list(map(float, data.split(","))))
    total_seconds = 1024 * 32768 / 44100
    xs = np.arange(len(ary)) * 60 / total_seconds
    plt.plot(xs, ary)
    plt.grid()
    plt.show()
else:
    with open("wave (2).txt", "r", encoding='utf_8_sig') as f:
        data = f.read()

    ary = np.array(list(map(float, data.split(","))))
    xs = np.arange(len(ary)) / 44100
    plt.plot(xs, ary)
    plt.grid()
    plt.show()

    from scipy.io.wavfile import write
    write("example.wav", 44100, ary)

