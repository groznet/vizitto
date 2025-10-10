// Alpine.js store and components
document.addEventListener('alpine:init', () => {

    const { nextTick } = Alpine
    
    Alpine.store('layout', {
        header: '',
        footer: '',

        async loadHeader() {
            try {
                const response = await fetch('/components/header.html');
                this.header = await response.text();

                // wait for Alpine to place the HTML into the DOM
                await nextTick();

                // initialize Alpine inside the inserted header
                const headerEl = document.getElementById('site-header');
                if (headerEl) Alpine.initTree(headerEl);
            } catch (error) {
                console.error('Error loading header:', error);
                this.header = '<div class="p-4">Error loading header</div>';
            }
        },

        async loadFooter() {
            try {
                const response = await fetch('/components/footer.html');
                this.footer = await response.text();

                await nextTick();
                const footerEl = document.getElementById('site-footer');
                if (footerEl) Alpine.initTree(footerEl);
            } catch (error) {
                console.error('Error loading footer:', error);
                this.footer = '<div class="p-4">Error loading footer</div>';
            }
        }
    });

    // Cards Page Script
    // Catalog component
    Alpine.data('catalog', () => ({
        // Data
        allListings: [],
        filteredListings: [],
        paginatedListings: [],
        selectedListing: null,
        
        // State
        lightboxOpen: false,
        currentPage: 1,
        itemsPerPage: 6,
        
        // Filters
        filters: {
            region: '',
            category: '',
            minRating: 0,
            price_level: ''
        },
        searchQuery: '',
        sortBy: 'rating',
        
        // Computed properties
        get regions() {
            return [...new Set(this.allListings.map(listing => listing.region))].sort();
        },
        
        get categories() {
            return [...new Set(this.allListings.map(listing => listing.category))].sort();
        },
        
        get totalPages() {
            return Math.ceil(this.filteredListings.length / this.itemsPerPage);
        },

        get services() {
            return [...new Set(this.allListings.flatMap(listing => listing.services))].sort();
        },
        
        
        // Methods
        async init() {
            await this.loadListings();
            this.filterListings();
        },
        
        async loadListings() {
            try {
                const response = await fetch('/data/cards.json');
                this.allListings = await response.json();
            } catch (error) {
                console.error('Error loading listings:', error);
                this.allListings = [];
            }
        },
        
        // Filtering method
        filterListings() {
            let filtered = [...this.allListings];
            
            // Search filter
            if (this.searchQuery) {
                const query = this.searchQuery.toLowerCase();
                filtered = filtered.filter(listing => 
                    listing.title.toLowerCase().includes(query) ||
                    listing.category.toLowerCase().includes(query) ||
                    listing.subcategory.toLowerCase().includes(query) ||
                    listing.tags.some(tag => tag.toLowerCase().includes(query)) ||
                    listing.description.toLowerCase().includes(query)
                );
            }
            
            // Region filter
            if (this.filters.region) {
                filtered = filtered.filter(listing => listing.region === this.filters.region);
            }
            
            // Category filter
            if (this.filters.category) {
                filtered = filtered.filter(listing => listing.category === this.filters.category);
            }
            
            // Rating filter
            if (this.filters.minRating > 0) {
                filtered = filtered.filter(listing => listing.rating >= this.filters.minRating);
            }

            // Price level filter
            if (this.filters.price_level) {
                filtered = filtered.filter(listing => listing.price_level == this.filters.price_level);
            }            
            
            this.filteredListings = filtered;
            this.currentPage = 1;
            this.sortListings();
            this.updatePagination();
        },
        
        // Sorting method
        sortListings() {
            switch (this.sortBy) {
                case 'rating':
                    this.filteredListings.sort((a, b) => b.rating - a.rating);
                    break;
                case 'updated_at':
                    this.filteredListings.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
                    break;
                case 'title_asc':
                    this.filteredListings.sort((a, b) => a.title.localeCompare(b.title));
                    break;
                case 'title_desc':
                    this.filteredListings.sort((a, b) => b.title.localeCompare(a.title));
                    break;
                case 'reviews':
                    this.filteredListings.sort((a, b) => b.reviews_count - a.reviews_count);
                    break;
            }
            this.updatePagination();
        },
        
        // Pagination methods
        updatePagination() {
            const startIndex = (this.currentPage - 1) * this.itemsPerPage;
            const endIndex = startIndex + this.itemsPerPage;
            this.paginatedListings = this.filteredListings.slice(startIndex, endIndex);
        },

        goToPage(page) {
            if (page < 1 || page > this.totalPages) return;
            this.currentPage = page;
            this.updatePagination();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        },

        shouldShowPage(page) {
            const delta = 2; // number of pages before/after current page to show
            return page === 1 || page === this.totalPages || (page >= this.currentPage - delta && page <= this.currentPage + delta);
        },

        showLeftDots(page) {
            return page === 2 && this.currentPage - 2 > 1;
        },

        showRightDots(page) {
            return page === this.totalPages - 1 && this.currentPage + 2 < this.totalPages;
        },
        // End pagination methods

        // Other methods
        resetFilters() {
            this.filters = {
                region: '',
                category: '',
                minRating: 0
            };
            this.searchQuery = '';
            this.sortBy = 'rating';
            this.filterListings();
        },
        
        openLightbox(listing) {
            this.selectedListing = listing;
            this.lightboxOpen = true;
            document.body.style.overflow = 'hidden';
        },
        
        closeLightbox() {
            this.lightboxOpen = false;
            this.selectedListing = null;
            document.body.style.overflow = 'auto';
        }
    }));
});

// Close lightbox on ESC key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const catalog = Alpine.$data(document.querySelector('[x-data="catalog()"]'));
        if (catalog && catalog.lightboxOpen) {
            catalog.closeLightbox();
        }
    }
});

// Run loaders after Alpine has finished initializing
document.addEventListener('alpine:initialized', () => {
    const store = Alpine.store && Alpine.store('layout');
    if (store) {
        store.loadHeader();
        store.loadFooter();
    }
});

// Fallback: if your Alpine version doesn't emit alpine:initialized, use DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
    // small delay to let alpine:init run if needed
    setTimeout(() => {
        const store = Alpine.store && Alpine.store('layout');
        if (store && !document.getElementById('site-header').innerHTML.trim()) {
            store.loadHeader();
            store.loadFooter();
        }
    }, 50);
});