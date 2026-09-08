+++
title = "Buddhabrot"
date = 2025-08-04
description = "Visiting the Mandelbrot's enlightened probability-distribution cousin."
[taxonomies]
tags = ["rust", "math", "creative-coding", "complex-dynamics"]
[extra]
thumbnail = "/images/buddhabrot.png"
+++

The Mandelbrot set has pulled off something rare for a piece of pure math, it got famous. It's on quite literally everything: posters, t-shirts, screensavers, tattoos, [blotter art](https://acidblotter.com/products/copy-of-fractals-x9-1-lsd-blotter-art-print) —
yet almost nobody who owns the merch can explain what it is. 
Very informally, it's the set of complex numbers \\(c\\) for which the function \\(f(z) = z^2 + c\\) doesn't diverge when iterated infinitely.

Renders of the set show an infinitely complex boundary that appears recursive and extremely detailed. You may also be familiar with
"zooms" of the Mandelbrot set that showcase this recursive nature:

<style>
  .mandelbrots-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    justify-items: center
  }
  .mandelbrots-grid img {
    max-width: 100%;
    height: auto;
    align-self: center;
  }
  .mandelbrots-grid figcaption {
    grid-column: 1 / -1;
  }
</style>

<figure class="mandelbrots-grid">
  <img class="zoomable" alt="Mandelbrot Set" src="https://upload.wikimedia.org/wikipedia/commons/thumb/2/21/Mandel_zoom_00_mandelbrot_set.jpg/1280px-Mandel_zoom_00_mandelbrot_set.jpg" />
  <img class="zoomable" alt="Mandelbrot Zoom" src="https://upload.wikimedia.org/wikipedia/commons/b/b8/Self-Similarity-Zoom.gif" />

  <figcaption>
    Render of the Mandelbrot set and a zoom from the <a href="https://en.wikipedia.org/wiki/Mandelbrot_set">Wikipedia page</a>.
  </figcaption>
</figure>

In this post I attempt to render the Buddhabrot, a related fractal spawned from the points that _do_ diverge.

# Where's the Buddha?

In short, the Buddhabrot is a probability distribution over the paths of points that diverge in the Mandelbrot set.
In other words, we look at each point that escapes the Mandelbrot set and track each point it passes through on its journey
to divergence. This essentially creates a heatmap of the most commonly-visited spots as points travel off to infinity. Here's what it looks like:

<figure>
  <img class="zoomable" alt="Buddhabrot" src="/images/buddhabrot.png" />

  <figcaption>
    The Buddhabrot, rendered from 16,000,000 escaping points.
  </figcaption>
</figure>

Wow! The image is still fractal in nature but with a ghostly, nebula-like element to it. In this way we can really see the fractal's namesake — the Buddha
sitting in meditation pose.

Okay, I'm actually lying to you. The picture above isn't the _real_ Buddhabrot. The real image is just black-and-white and can look completely different based on the parameters you choose.
I'll show you the rendering process involved in creating the final image.

# The Rendering Process

The logic behind rendering a Buddhabrot image is simple. First, we create a 2D image buffer with dimensions
`WIDTH` \\(\times\\) `HEIGHT`, mapped onto the viewport \\([-2, 2] \times [-2, 2]\\) in the complex plane. Each pixel \\((m, n)\\) for \\(m = 1, \ldots , \mathrm{WIDTH}\\) and \\(n = 1, \ldots , \mathrm{HEIGHT}\\) corresponds to the complex number
\\(c = \left(-2 + \frac{4m}{\mathrm{WIDTH}}\right) + \left(-2 + \frac{4n}{\mathrm{HEIGHT}}\right) i\\).

Each pixel has an associated counter that starts at 0. We sample `SAMPLES` random points (in our case 16,000,000) and iterate them
through the Mandelbrot function \\(f(z) = z^2 + c\\). For points that escape within `MAX_ITERATIONS`, we increment the counters
of all pixels passed through during that process. We discard points that never escape.

In the end, we have a histogram showing the likelihood that escaped points pass through a given pixel. The final step is to color each pixel in the output image a certain
grayscale value based on the normalized range of all pixel counter values.

What we end up with is an image like so:

<style>
  .iterations-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1rem;
    justify-items: center;
  }
  .iterations-grid img {
    max-width: 100%;
    height: auto;
  }
  .iterations-grid figcaption {
    grid-column: 1 / -1;
  }
</style>

<figure class="iterations-grid">
  <img class="zoomable" alt="Buddhabrot MAX_ITERATIONS=16" src="/images/buddhabrot_16.png" />
  <img class="zoomable" alt="Buddhabrot MAX_ITERATIONS=64" src="/images/buddhabrot_64.png" />
  <img class="zoomable" alt="Buddhabrot MAX_ITERATIONS=256" src="/images/buddhabrot_256.png" />
  <img class="zoomable" alt="Buddhabrot MAX_ITERATIONS=4096" src="/images/buddhabrot_4096.png" />

  <figcaption>
    Buddhabrot renders with (from top-left to bottom-right) MAX_ITERATIONS=16, 64, 256, 4096.
  </figcaption>
</figure>

Great! But these images are still in black-and-white. In the following section, I borrow a technique from astronomy
to breathe life into these pictures.

# Pseudocolor

Pseudocolor techniques map intensity values to colors in grayscale images. If you're wondering why the first Buddhabrot image looks like some sort of nebula,
it's because astronomers have been doing this sort of thing for years — mapping X-rays and infrared into something human eyes can see (the universe has famously terrible taste in visible light).
I'm doing the same thing here, just for a fractal instead of a nebula.

In our case, we can change the value of `MAX_ITERATIONS` and map each output image to a specific color. Then, we layer the images on top of each other with the correct blending mode to
produce the final colorized image:

<figure>
  <img class="zoomable" alt="Buddhabrot Color Combinations" src="/images/buddhabrot_color-combos.png" />

  <figcaption>
    MAX_ITERATIONS=64 mapped to blue, 256 to red, and 4096 to green, combined with lighten blending mode.
  </figcaption>
</figure>

Below are a few examples of zoomed-in pseudocolor Buddhabrots:

<style>
  .pseudocolor-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
    justify-items: center;
  }
  .pseudocolor-grid img {
    max-width: 100%;
    height: auto;
  }
</style>

<figure class="pseudocolor-grid">
  <img class="zoomable" alt="Buddhabrot Zoom @ -0.3 + 0.65i" src="/images/buddhabrot_-0.3x0.65.png">
  <figcaption>
    Pseudocolor Buddhabrot zoom centered at -0.3 + 0.65i
  </figcaption>
</figure>

<br>

<figure class="pseudocolor-grid">
  <img class="zoomable" alt="Buddhabrot Zoom @ -1.25 + 0.0i" src="/images/buddhabrot_-1.25x0.png">
  <figcaption>
    Pseudocolor Buddhabrot zoom centered at -1.25 + 0.0i
  </figcaption>
</figure>

# Towards Nirvana

The goal of this experiment was to create some neat visualizations using Rust and learn a thing or two along the way — modest goals as far as spiritual journeys go. While I was able to significantly decrease
rendering times by parallelizing with [rayon](https://crates.io/crates/rayon), the computation remains solely on the CPU. Perhaps one day I'll revisit the Buddha on the GPU,
similar to [this project](https://benedikt-bitterli.me/buddhabrot/). I'd also love to approach the rendering process through a [probabilistic lens](http://www.steckles.com/buddha/) by leveraging the
[Metropolis-Hastings Algorithm](https://en.wikipedia.org/wiki/Metropolis%E2%80%93Hastings_algorithm).
